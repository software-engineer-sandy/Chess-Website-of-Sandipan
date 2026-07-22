let board = null;
let game = new Chess();
let moveHistoryFEN = [];
let playerColor = 'w';
let forceGameOver = false;

const $status = $('#status');
const $arrowSvg = document.getElementById('arrow-svg');

function createEngine() {
    return new Worker('stockfish.js');
}

const mainEngine = createEngine();    
const evalWorker = createEngine();    
const assistWorker = createEngine();  

function askEngine(engine, commands) {
    return new Promise((resolve) => {
        let output = [];
        const handler = (e) => {
            const line = typeof e.data === 'string' ? e.data : '';
            if (line) output.push(line);
            if (line.startsWith('bestmove')) {
                engine.removeEventListener('message', handler);
                resolve(output);
            }
        };
        engine.addEventListener('message', handler);
        commands.forEach(cmd => engine.postMessage(cmd));
    });
}

function updateProbabilities() {
    const currentFen = game.fen();
    evalWorker.postMessage('stop'); 
    evalWorker.postMessage(`position fen ${currentFen}`);
    evalWorker.postMessage('go depth 12');
}

evalWorker.onmessage = function(e) {
    const line = typeof e.data === 'string' ? e.data : '';
    if (line.includes('score cp') || line.includes('score mate')) {
        const match = line.match(/score (cp|mate) (-?\d+)/);
        if (match) {
            const type = match[1];
            let score = parseInt(match[2], 10);
            
            if (game.turn() === 'b') {
                score = -score;
            }
            
            let wProb, bProb;
            if (type === 'mate') {
                wProb = score > 0 ? 100 : 0;
                bProb = score > 0 ? 0 : 100;
            } else {
                const probW = 1 / (1 + Math.pow(10, -score / 400));
                wProb = (probW * 100).toFixed(1);
                bProb = ((1 - probW) * 100).toFixed(1);
            }
            
            $('#win-prob-white').text(`White: ${wProb}%`);
            $('#win-prob-black').text(`Black: ${bProb}%`);
            $('#eval-fill').css('width', `${wProb}%`);
        }
    }
};

function updateStatus() {
    if (forceGameOver) return; 

    let statusHTML = '';
    if (game.in_checkmate()) statusHTML = 'Game over, ' + (game.turn() === 'w' ? 'Black' : 'White') + ' won.';
    else if (game.in_draw()) statusHTML = 'Game over, drawn position';
    else {
        statusHTML = (game.turn() === 'w' ? 'White to move' : 'Black to move');
        if (game.in_check()) statusHTML += ', ' + (game.turn() === 'w' ? 'White' : 'Black') + ' is in check';
    }
    $status.text(statusHTML);
    updateProbabilities(); 
}

function getSquareCoordinates(square) {
    const file = square.charCodeAt(0) - 97;
    const rank = 8 - parseInt(square[1]);
    const squareSize = 500 / 8;
    
    let x = (file * squareSize) + (squareSize / 2);
    let y = (rank * squareSize) + (squareSize / 2);

    if (playerColor === 'b') {
        x = 500 - x;
        y = 500 - y;
    }
    return { x, y };
}

function drawArrow(move, color) {
    if (!move || move.length < 4) return;
    const from = move.substring(0, 2);
    const to = move.substring(2, 4);
    
    const start = getSquareCoordinates(from);
    const end = getSquareCoordinates(to);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', start.x);
    line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x);
    line.setAttribute('y2', end.y);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '7');
    line.setAttribute('marker-end', `url(#arrowhead-${color})`);
    line.setAttribute('opacity', '0.75');
    $arrowSvg.appendChild(line);
}

function setupSVGDef() {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    ['green', 'red'].forEach(color => {
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', `arrowhead-${color}`);
        marker.setAttribute('markerWidth', '10');
        marker.setAttribute('markerHeight', '7');
        marker.setAttribute('refX', '8');
        marker.setAttribute('refY', '3.5');
        marker.setAttribute('orient', 'auto');
        
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
        polygon.setAttribute('fill', color);
        marker.appendChild(polygon);
        defs.appendChild(marker);
    });
    $arrowSvg.appendChild(defs);
}

async function updateAssistance() {
    $arrowSvg.innerHTML = '';
    setupSVGDef();
    
    if ($('#assistance').val() === 'off' || game.game_over() || forceGameOver) return;
    if (game.turn() !== playerColor) return;

    const currentFen = game.fen();

    const playerCommands = [
        'uci', 'setoption name MultiPV value 3', `position fen ${currentFen}`, 'go depth 10'
    ];
    const playerOutput = await askEngine(assistWorker, playerCommands);
    
    let fenTokens = currentFen.split(' ');
    fenTokens[1] = fenTokens[1] === 'w' ? 'b' : 'w'; 
    fenTokens[3] = '-'; 
    const flippedFen = fenTokens.join(' ');

    const opponentCommands = [
        'uci', 'setoption name MultiPV value 3', `position fen ${flippedFen}`, 'go depth 10'
    ];
    const opponentOutput = await askEngine(assistWorker, opponentCommands);
    
    const extractMoves = (output) => {
        const moves = [];
        output.forEach(line => {
            if (line.includes('pv ') && line.includes('multipv')) {
                const parts = line.split(' pv ');
                if (parts[1]) moves.push(parts[1].split(' ')[0]);
            }
        });
        return [...new Set(moves)].slice(0, 3);
    };

    extractMoves(playerOutput).forEach(move => drawArrow(move, 'green'));
    extractMoves(opponentOutput).forEach(move => drawArrow(move, 'red'));
}

function handleGameEnd() {
    $('#review-btn').prop('disabled', false);
    $('#resign-btn').prop('disabled', true);
    $('#draw-btn').prop('disabled', true);
    mainEngine.postMessage('stop');
}

async function makeOpponentMove() {
    if (forceGameOver) return;

    $status.text("Opponent is thinking...");
    const elo = parseInt($('#elo').val());
    
    const commands = [
        'uci', 'setoption name UCI_LimitStrength value true',
        `setoption name UCI_Elo value ${Math.max(100, Math.min(elo, 3500))}`,
        `position fen ${game.fen()}`, 'go movetime 1000'
    ];

    const output = await askEngine(mainEngine, commands);
    const bestMoveLine = output.find(line => line.startsWith('bestmove'));
    const bestMove = bestMoveLine ? bestMoveLine.split(' ')[1] : null;

    if (bestMove && !forceGameOver) {
        game.move({
            from: bestMove.substring(0, 2),
            to: bestMove.substring(2, 4),
            promotion: bestMove.length > 4 ? bestMove.substring(4) : undefined
        });
        board.position(game.fen());
        moveHistoryFEN.push(game.fen());
        updateStatus();
        updateAssistance();

        if (game.game_over()) handleGameEnd();
    }
}

function onDragStart(source, piece, position, orientation) {
    if (game.game_over() || forceGameOver) return false;
    if (game.turn() !== playerColor || piece.charAt(0) !== playerColor) return false;
}

async function onDrop(source, target) {
    const move = game.move({
        from: source,
        to: target,
        promotion: 'q'
    });

    if (move === null) return 'snapback';

    $arrowSvg.innerHTML = '';
    setupSVGDef();
    moveHistoryFEN.push(game.fen());
    updateStatus();

    if (game.game_over()) {
        handleGameEnd();
        return;
    }
    makeOpponentMove();
}

// Controls
$('#start-btn').on('click', () => {
    playerColor = $('#player-color').val();
    game.reset();
    board.start();
    board.orientation(playerColor === 'w' ? 'white' : 'black');
    
    moveHistoryFEN = [game.fen()];
    forceGameOver = false;

    $('#review-btn').prop('disabled', true);
    $('#resign-btn').prop('disabled', false);
    $('#draw-btn').prop('disabled', false);

    $arrowSvg.innerHTML = '';
    setupSVGDef();
    
    updateStatus();
    updateAssistance();

    if (playerColor === 'b') {
        makeOpponentMove();
    }
});

$('#resign-btn').on('click', () => {
    if (game.game_over() || forceGameOver) return;
    forceGameOver = true;
    let winner = playerColor === 'w' ? 'Black' : 'White';
    $status.text(`Game over, you resigned. ${winner} won.`);
    handleGameEnd();
});

$('#draw-btn').on('click', () => {
    if (game.game_over() || forceGameOver) return;
    forceGameOver = true;
    $status.text('Game over, drawn by agreement.');
    handleGameEnd();
});

$('#review-btn').on('click', () => {
    sessionStorage.setItem('moveHistoryFEN', JSON.stringify(moveHistoryFEN));
    sessionStorage.setItem('fullHistory', JSON.stringify(game.history({ verbose: true })));
    sessionStorage.setItem('playerColor', playerColor);
    window.location.href = 'review.html';
});

// Initialization
const config = {
    draggable: true,
    position: 'start',
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: () => board.position(game.fen()),
    pieceTheme: 'img/chesspieces/wikipedia/{piece}.png'
};
board = Chessboard('board', config);
setupSVGDef();
updateStatus();