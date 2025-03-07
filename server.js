const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile('index.html', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

function seededRandom(seed) {
    let state = seed;
    return function() {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
    };
}

const games = {};

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid message format:', message);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
            return;
        }

        console.log('Received message:', data);

        switch (data.type) {
            case 'createGame':
                const gameId = Math.random().toString(36).substr(2, 5).toUpperCase();
                games[gameId] = {
                    players: [{ ws, id: 1, board: Array(20).fill().map(() => Array(10).fill(0)), gameOver: false }],
                    pieceQueue: [],
                    random: seededRandom(parseInt(gameId, 36)),
                    started: false
                };
                fillPieceQueue(games[gameId]);
                ws.send(JSON.stringify({ type: 'gameCreated', gameId, playerId: 1 }));
                console.log(`Game ${gameId} created by Player 1`);
                break;

            case 'joinGame':
                const joinGameId = data.gameId;
                if (!joinGameId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game ID required' }));
                    console.log('Join attempt failed: No gameId provided');
                    return;
                }
                if (!games[joinGameId]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
                    console.log(`Join attempt failed: Game ${joinGameId} not found`);
                    return;
                }
                if (games[joinGameId].started) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game already started' }));
                    console.log(`Join attempt failed: Game ${joinGameId} already started`);
                    return;
                }
                if (games[joinGameId].players.length >= 4) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game is full' }));
                    console.log(`Join attempt failed: Game ${joinGameId} is full`);
                    return;
                }
                const playerId = games[joinGameId].players.length + 1;
                games[joinGameId].players.push({ ws, id: playerId, board: Array(20).fill().map(() => Array(10).fill(0)), gameOver: false });
                ws.send(JSON.stringify({ type: 'gameJoined', gameId: joinGameId, playerId }));
                broadcast(joinGameId, { type: 'playerJoined', playerId });
                console.log(`Player ${playerId} joined game ${joinGameId}`);
                break;

            case 'startGame':
                if (!games[data.gameId] || games[data.gameId].players[0].ws !== ws) return;
                games[data.gameId].started = true;
                fillPieceQueue(games[data.gameId]);
                const firstPiece = games[data.gameId].pieceQueue.shift();
                broadcast(data.gameId, { type: 'gameStarted', piece: firstPiece });
                fillPieceQueue(games[data.gameId]);
                console.log(`Game ${data.gameId} started`);
                break;

            case 'clearLines':
                const game = games[data.gameId];
                if (!game || game.players[data.playerId - 1].gameOver) return;
                const linesCleared = data.linesCleared;
                game.players[data.playerId - 1].board = data.board;
                if (linesCleared > 0) {
                    const currentIndex = game.players.findIndex(p => p.id === data.playerId);
                    let nextPlayer = null;
                    for (let i = 1; i <= game.players.length; i++) {
                        const nextIndex = (currentIndex + i) % game.players.length;
                        if (!game.players[nextIndex].gameOver) {
                            nextPlayer = game.players[nextIndex];
                            break;
                        }
                    }
                    if (nextPlayer) {
                        const linesToAdd = linesCleared - 1;
                        for (let i = 0; i < linesToAdd; i++) {
                            nextPlayer.board.shift();
                            const newLine = Array(10).fill(1);
                            for (let j = 0; j < 2; j++) {
                                newLine[Math.floor(Math.random() * 10)] = 0;
                            }
                            nextPlayer.board.push(newLine);
                        }
                        nextPlayer.ws.send(JSON.stringify({ type: 'addLines', board: nextPlayer.board }));
                    }
                }
                // Broadcast the next piece to all players
                const nextPiece = game.pieceQueue.shift();
                broadcast(data.gameId, { type: 'nextPiece', piece: nextPiece });
                fillPieceQueue(game);
                break;

            case 'gameOver':
                const g = games[data.gameId];
                if (!g) return;
                g.players[data.playerId - 1].gameOver = true;
                broadcast(data.gameId, { type: 'playerOut', playerId: data.playerId });
                const activePlayers = g.players.filter(p => !p.gameOver);
                if (activePlayers.length <= 1) {
                    broadcast(data.gameId, { type: 'gameEnded', winner: activePlayers.length === 1 ? activePlayers[0].id : null });
                    delete games[data.gameId];
                }
                break;

            case 'listGames':
                const availableGames = Object.keys(games)
                    .filter(gameId => !games[gameId].started && games[gameId].players.length < 4)
                    .map(gameId => ({
                        gameId,
                        playerCount: games[gameId].players.length
                    }));
                ws.send(JSON.stringify({ type: 'gameList', games: availableGames }));
                break;

            default:
                console.log('Unknown message type:', data.type);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

function fillPieceQueue(game) {
    const pieces = [
        { shape: [[1, 1, 1, 1]], type: 'I' },           // I
        { shape: [[1, 1], [1, 1]], type: 'O' },         // O
        { shape: [[1, 1, 1], [0, 1, 0]], type: 'T' },   // T
        { shape: [[0, 1, 1], [1, 1, 0]], type: 'S' },   // S
        { shape: [[1, 1, 0], [0, 1, 1]], type: 'Z' },   // Z
        { shape: [[1, 0, 0], [1, 1, 1]], type: 'J' },   // J
        { shape: [[0, 0, 1], [1, 1, 1]], type: 'L' }    // L
    ];
    while (game.pieceQueue.length < 5) {
        const pieceIndex = Math.floor(game.random() * pieces.length);
        game.pieceQueue.push(pieces[pieceIndex]);
    }
}

function broadcast(gameId, message) {
    if (!games[gameId]) return;
    games[gameId].players.forEach(player => {
        if (!player.gameOver) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

server.listen(process.env.PORT || 8080, () => {
    console.log(`Server running on http://localhost:${process.env.PORT || 8080}`);
});
