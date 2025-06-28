require('dotenv').config();

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const morgan = require("morgan");
const registerSocketHandlers = require("./managers/EventHandlers");

const app = express();
const server = http.createServer(app);
const { Chess } = require("chess.js"); // Needed for board state logic
const ongoingGames = [];
const sessions = {};

// Safely emit to a socket if it exists
function safeEmit(socketId, event, payload) {
  if (!socketId) return;
  const s = io.sockets.sockets.get(socketId);
  if (s) {
    s.emit(event, payload);
  }
}

function findCurrentGameBySocket(socketId) {
  // Check ongoingGames first (classic pairing)
  for (const game of ongoingGames) {
    if (game.student?.id === socketId || game.mentor?.id === socketId) {
      return game;
    }
  }

  // Check session-based games
  for (const sessionId in sessions) {
    const session = sessions[sessionId];
    if (session.student?.id === socketId || session.mentor?.id === socketId) {
      return session;
    }
  }

  return null;
}


// Add logging functionaility to the server
app.use(morgan("dev")) // dev -> preset format

// Apply CORS middleware to handle cross-origin requests
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
}));

// Initialize Socket.IO with CORS configuration
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Register socket event handlers upon client connection
io.on("connection", (socket) => {
  console.log("a user connected to socket");
  


  /// Purpose: Handle new game initialization or join an existing game.
  /// Input: { student: string (e.g., "Alice"), mentor: string (e.g., "Bob"), role: string ("mentor"/"student") }
  /// Output: { boardState: string (e.g., "initial_board_state"), color: string ("black"/"white") }

  socket.on("newgame", (msg) => {
    
    let currentGame;
    let newGame = true;
    var parsedmsg = JSON.parse(msg);
    console.log(msg);


    // checking if student/mentor already in an ongoing game
    for (let game of ongoingGames) {
      
      if (game.student.username == parsedmsg.student || game.mentor.username == parsedmsg.mentor) {
        newGame = false;
        currentGame = game;
        break;  // breaks early, since we no longer need to go through this loop
      }
    }

    // if student/mentor not in ongoing game, create a newgame
    if (newGame) {
      let chessState = new Chess();
      
      let colors = [];
      
      var studentSocket = "";
      var mentorSocket = "";

      // determining outputs based on role of client
      if (parsedmsg.role == "student") 
      {
        colors = ["black", "white"];
        studentSocket = socket.id;
      } 
      else if (parsedmsg.role == "mentor")
      {
        colors = ["white", "black"];
        mentorSocket = socket.id;
      }
      else { 
        io.emit("error : invalid value for msg.role. Requires student/mentor")  
      }

      // determining color of client peices
      let clientColor = (parsedmsg) => 
        parsedmsg.role === "student" ? colors[0] : 
        parsedmsg.role === "mentor" ? colors[1] : 
        null;
      
      const color = clientColor(parsedmsg);

      // saving game to ongoingGames
      currentGame = {
        student: {
          username: parsedmsg.student,
          id: studentSocket,
          color: colors[0],
        },
        mentor: { 
          username: parsedmsg.mentor, 
          id: mentorSocket, 
          color: colors[1] 
        },
        boardState: chessState,
        pastStates: []
      };

      ongoingGames.push(currentGame);

      // emitting board state to client
      io.emit(
        "boardstate",
        JSON.stringify({ boardState: currentGame.boardState.fen(), color: color
        })
      );
    
      // Set client ids,
    }
    else if (newGame == false)
    {
      // Set the new client id for student or mentor.
      let color;
        
      if (parsedmsg.role == "student") 
      {
        currentGame.student.id = socket.id;
        color = currentGame.student.color;
      } 
      else if (parsedmsg.role == "mentor") 
      {
        currentGame.mentor.id = socket.id;
        color = currentGame.mentor.color;
      } 
      
      

      // emitting board state
      io.to(socket.id).emit(
        "boardstate",
        JSON.stringify({ boardState: currentGame.boardState.fen(), color: color})
      );
    }
    else {
      // TODO : implement exception : newgame is null
    }
    
  });

  socket.on("createSession", (msg) => {
  try {
    const { sessionId, username, role } = JSON.parse(msg);

    if (sessions[sessionId]) {
      socket.emit("error", `Session "${sessionId}" already exists.`);
      return;
    }

    const chessState = new Chess();
    const color = role === "mentor" ? "white" : "black";

    sessions[sessionId] = {
      boardState: chessState,
      pastStates: [],
      [role]: { username, id: socket.id, color }
    };

    socket.join(sessionId);
    socket.emit("sessionCreated", JSON.stringify({
      boardState: chessState.fen(),
      color
    }));

    console.log(`Created session ${sessionId} by ${username} as ${role}`);
  } catch (err) {
    console.error("Error in createSession:", err);
    socket.emit("error", "Invalid createSession payload");
  }
});

socket.on("joinSession", (msg) => {
  try {
    const { sessionId, username, role } = JSON.parse(msg);

    const session = sessions[sessionId];
    if (!session) {
      socket.emit("error", `Session "${sessionId}" not found.`);
      return;
    }

    if (session[role]) {
      socket.emit("error", `Role "${role}" is already taken.`);
      return;
    }

    const color = role === "mentor" ? "white" : "black";
    session[role] = { username, id: socket.id, color };

    socket.join(sessionId);

    // Notify this user
    socket.emit("sessionJoined", JSON.stringify({
      boardState: session.boardState.fen(),
      color
    }));

    // Notify both users with latest board state
    if (session.mentor && session.student) {
      safeEmit(
        session.mentor.id,
        "boardstate",
        JSON.stringify({
          boardState: session.boardState.fen(),
          color: session.mentor.color,
        })
      );
      safeEmit(
        session.student.id,
        "boardstate",
        JSON.stringify({
          boardState: session.boardState.fen(),
          color: session.student.color,
        })
      );
    }

    console.log(`${username} joined session ${sessionId} as ${role}`);
  } catch (err) {
    console.error("Error in joinSession:", err);
    socket.emit("error", "Invalid joinSession payload");
  }
});


  /// Purpose: Changes state of existing game.
  /// Input: { from: e2, to: e3 }
  /// Output: { boardState: string (e.g., "initial_board_state"), color: string ("black"/"white") }
  socket.on("move", (msg) => {
    
    console.log(msg);

    parsedmsg = JSON.parse(msg);

    // checking student/mentor is in an ongoing game
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    if (currentGame)
    {
      


      let currentState = currentGame.boardState;
      let pastState = currentState;
      // Get initial state




      // Attempt to make a legal move
      let move = currentState.move({ from: parsedmsg.from, to: parsedmsg.to }); // Move the pawn to e4

      // Testing legal move
      if (move) {
        currentGame.boardState = currentState;
        console.log('Move made:', move);
      } else {
        console.log('Illegal move');
      }

      // broadcast current board state to mentor and student
      
      
      safeEmit(
        currentGame.mentor?.id,
        "boardstate",
        JSON.stringify({ boardState: currentGame.boardState.fen() })
      );

      safeEmit(
        currentGame.student?.id,
        "boardstate",
        JSON.stringify({ boardState: currentGame.boardState.fen() })
      );

    }

  });

  /// Purpose: End an ongoing game and remove it from the list.
  /// Input: { username: string (e.g., "Alice") }
  /// Output: { success: boolean (true/false) }

  socket.on("endgame", (msg) => {
    var parsedmsg = JSON.parse(msg);
    console.log(msg);
    console.log("ending game on server");

    let index = 0;
    ongoingGames.forEach((game) => {
      if (
        game.student.username == parsedmsg.student &&
        game.mentor.username == parsedmsg.mentor
      ) {

        safeEmit(game.mentor?.id, "reset", undefined);

        safeEmit(game.student?.id, "reset", undefined);

        ongoingGames.splice(index, 1);
        console.log(ongoingGames);
      }
      index++;
    });     
    
    

  });

  /// Purpose: Request to undo the last moves.
  /// Input: { moveId: string (e.g., "move123"), playerId: string (e.g., "player1") }
  /// Output: { success: boolean (true/false), moveId: string (e.g., "move123") }

  socket.on("undo", (msg) => {
  
    console.log(msg);

    parsedmsg = JSON.parse(msg);

    // checking student/mentor is in an ongoing game
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    if (currentGame)
    {
      
      let currentState = currentGame.boardState;
      
      currentState.undo();

      currentGame.boardState = currentState;

      console.log(currentGame.boardState.fen());

      // broadcast current board state to mentor and student
      safeEmit(
        currentGame.mentor?.id,
        "boardstate",
        JSON.stringify({ boardState: currentGame.boardState.fen() })
      );

      safeEmit(
        currentGame.student?.id,
        "boardstate",
        JSON.stringify({ boardState: currentGame.boardState.fen() })
      );

      
      console.log(currentGame);

    }
  });



  socket.on("setstate", (msg) => {

    

    console.log(msg);

    parsedmsg = JSON.parse(msg);
    
    state = parsedmsg.state;

    // checking student/mentor is in an ongoing game
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) return;

    currentGame.boardState = new Chess(state);


    safeEmit(
      currentGame.mentor?.id,
      "boardstate",
      JSON.stringify({ boardState: currentGame.boardState.fen() })
    );

    safeEmit(
      currentGame.student?.id,
      "boardstate",
      JSON.stringify({ boardState: currentGame.boardState.fen() })
    );


  });

  socket.on("lastmove", (msg) => {
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    let from = parsedmsg.from;
    let to = parsedmsg.to;

    //const validCoordinate = (letter, number) => ['a','b','c','d','e','f','g','h'].includes(letter) && number > 0 && number < 9;

    // checking for good coordinate
    //if (from.letter && from.number && to.letter && to.number)
    //{
        
      //if (validCoordinate(from.letter, from.number) && validCoordinate(to.letter, to.number))
      //{
              
    safeEmit(
      currentGame.mentor?.id,
      "lastmove",
      JSON.stringify({ from, to })
    );

    safeEmit(
      currentGame.student?.id,
      "lastmove",
      JSON.stringify({ from, to })
    );
      //}
      //else
      //{
        // bad highlight
      //}
    //}
    //else { 
      // bad entry
    //}


      

  });

  socket.on("addgrey", (msg) => {
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    let to = parsedmsg.to;

    if (currentGame)
    {
      if (currentGame.mentor.id != clientSocket) {
        safeEmit(currentGame.mentor?.id, "addgrey", JSON.stringify({ to }));
      } else if (currentGame.student.id != clientSocket) {
        safeEmit(currentGame.student?.id, "addgrey", JSON.stringify({ to }));
      } else {
        console.log("bad request, no client to send greysquare to");
      }
    }

  }); 

  
  socket.on("removegrey", (msg) => {
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    let to = parsedmsg.to;

    if (currentGame)
    {
        
      if (currentGame.mentor.id != clientSocket) {
        safeEmit(currentGame.mentor?.id, "removegrey", JSON.stringify({}));
      } else if (currentGame.student.id != clientSocket) {
        safeEmit(currentGame.student?.id, "removegrey", JSON.stringify({}));
      } else {
        console.log("bad request, no client to send greysquare to");
      }
    }
   

  }); 
  
  socket.on("mousexy", (msg) => {
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    let x = parsedmsg.x;
    let y = parsedmsg.y;

    if (currentGame)
    {
        
      if (currentGame.mentor.id != clientSocket) {
        safeEmit(currentGame.mentor?.id, "mousexy", JSON.stringify({ x, y }));
      } else if (currentGame.student.id != clientSocket) {
        safeEmit(currentGame.student?.id, "mousexy", JSON.stringify({ x, y }));
      } else {
        console.log("bad request, no client to send mouse xy to");
      }
    }
   

  }); 

  socket.on("piecedrop", (msg) => {
    console.log('dropping piece');
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    
    if (currentGame)
    {
        
      if (currentGame.mentor.id != clientSocket) {
        safeEmit(currentGame.mentor?.id, "piecedrop", JSON.stringify({}));
      } else if (currentGame.student.id != clientSocket) {
        safeEmit(currentGame.student?.id, "piecedrop", JSON.stringify({}));
      } else {
        console.log("bad request, no client to send mouse xy to");
      }
    }
   

  }); 

  socket.on("piecedrag", (msg) => {
    console.log('dragging piece');
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    let piece = parsedmsg.piece;

    if (currentGame)
    {
        
      if (currentGame.mentor.id != clientSocket) {
        safeEmit(currentGame.mentor?.id, "piecedrag", JSON.stringify({ piece }));
      } else if (currentGame.student.id != clientSocket) {
        safeEmit(currentGame.student?.id, "piecedrag", JSON.stringify({ piece }));
      } else {
        console.log("bad request, no client to send mouse xy to");
      }
    }
   

  }); 

  socket.on("highlight", (msg) => {
    console.log('getting highlight future move');
    var clientSocket = socket.id;
    const currentGame = findCurrentGameBySocket(socket.id);
    if (!currentGame) {
      console.log("No game found for socket", socket.id);
      return;
    }

    // getting message variables
    parsedmsg = JSON.parse(msg);
    let from = parsedmsg.from;
    let to = parsedmsg.to;

    if (currentGame)
    {
        
      if (currentGame.mentor.id != clientSocket) {
        safeEmit(currentGame.mentor?.id, "highlight", JSON.stringify({ from, to }));
      } else if (currentGame.student.id != clientSocket) {
        safeEmit(currentGame.student?.id, "highlight", JSON.stringify({ from, to }));
      } else {
        console.log("bad request, no client to send mouse xy to");
      }
    }
   

  }); 
  registerSocketHandlers(socket, io);
});

// Start the server and listen on the defined port
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = { server, io };