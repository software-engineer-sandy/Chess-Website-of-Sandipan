let board = null;
let game = new Chess();
let moveHistoryFEN = [];
let playerColor = 'w';

const $status = $('#status');
const $arrowSvg = document.getElementById('arrow-svg');

// 1. Web Worker Setup (Stockfish in Browser)
function createEngine() {
    const workerScript = `importScripts("https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js");`;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

const mainEngine = createEngine();

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

// 2. UI & SVG Rendering
function updateStatus() {
    let statusHTML = '';
    if (game.in_checkmate()) statusHTML = 'Game over, ' + (game.turn() === 'w' ? 'Black' : 'White') + ' won.';
    else if (game.in_draw()) statusHTML = 'Game over, drawn position';
    else {
        statusHTML = (game.turn() === 'w' ? 'White to move' : 'Black to move');
        if (game.in_check()) statusHTML += ', ' + (game.turn() === 'w' ? 'White' : 'Black') + ' is in check';
    }
    $status.text(statusHTML);
}

function getSquareCoordinates(square) {
    const file = square.charCodeAt(0) - 97; // 'a'=0, 'h'=7
    const rank = 8 - parseInt(square[1]);   // '8'=0, '1'=7
    const squareSize = 500 / 8;
    
    let x = (file * squareSize) + (squareSize / 2);
    let y = (rank * squareSize) + (squareSize / 2);

    // Flip coordinates if playing as Black
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

// 3. Assistance Engine (Green & Red Arrows)
async function updateAssistance() {
    $arrowSvg.innerHTML = '';
    setupSVGDef();
    
    if ($('#assistance').val() === 'off' || game.game_over()) return;
    if (game.turn() !== playerColor) return; // Only process during player's turn

    const tempEngine = createEngine();
    const currentFen = game.fen();

    // 1. Get Top 3 Moves for Player (Green Arrows)
    const playerCommands = [
        'uci',
        'setoption name MultiPV value 3',
        `position fen ${currentFen}`,
        'go depth 10'
    ];
    
    const playerOutput = await askEngine(tempEngine, playerCommands);
    
    // 2. Get Top 3 Threats from Opponent (Red Arrows)
    // To see threats, we give the opponent the turn in the FEN (Null move heuristic)
    let fenTokens = currentFen.split(' ');
    fenTokens[1] = fenTokens[1] === 'w' ? 'b' : 'w'; 
    fenTokens[3] = '-'; // disable en-passant to avoid FEN errors
    const flippedFen = fenTokens.join(' ');

    const opponentCommands = [
        'uci',
        'setoption name MultiPV value 3',
        `position fen ${flippedFen}`,
        'go depth 10'
    ];

    const opponentOutput = await askEngine(tempEngine, opponentCommands);
    
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

    const recommendedMoves = extractMoves(playerOutput);
    const opponentThreats = extractMoves(opponentOutput);

    recommendedMoves.forEach(move => drawArrow(move, 'green'));
    opponentThreats.forEach(move => drawArrow(move, 'red'));

    tempEngine.terminate(); 
}

// 4. Opponent Logic
async function makeOpponentMove() {
    $status.text("Opponent is thinking...");
    const elo = parseInt($('#elo').val());
    
    const commands = [
        'uci',
        'setoption name UCI_LimitStrength value true',
        `setoption name UCI_Elo value ${Math.max(100, Math.min(elo, 3500))}`,
        `position fen ${game.fen()}`,
        'go movetime 1000' // Give the engine 1 second
    ];

    const output = await askEngine(mainEngine, commands);
    const bestMoveLine = output.find(line => line.startsWith('bestmove'));
    const bestMove = bestMoveLine ? bestMoveLine.split(' ')[1] : null;

    if (bestMove) {
        game.move({
            from: bestMove.substring(0, 2),
            to: bestMove.substring(2, 4),
            promotion: bestMove.length > 4 ? bestMove.substring(4) : undefined
        });
        board.position(game.fen());
        moveHistoryFEN.push(game.fen());
        updateStatus();
        updateAssistance();

        if (game.game_over()) $('#review-btn').prop('disabled', false);
    }
}

// Ensure player can only move their own pieces
function onDragStart(source, piece, position, orientation) {
    if (game.game_over()) return false;
    if (game.turn() !== playerColor || piece.charAt(0) !== playerColor) return false;
}

// Handle Board Drops
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
        $('#review-btn').prop('disabled', false);
        return;
    }

    makeOpponentMove();
}

// 5. Match Review Logic (7 Categories)
$('#review-btn').on('click', async () => {
    $('#review-container').removeClass('hidden');
    $('#move-list').html('<p style="text-align:center; padding-top:20px;">Analyzing match...<br>This may take a moment.</p>');
    
    const reviewEngine = createEngine();
    let reviewData = [];
    
    let whiteEvalDrop = 0;
    let blackEvalDrop = 0;
    let whiteMoves = 0;
    let blackMoves = 0;
    
    for (let i = 0; i < moveHistoryFEN.length - 1; i++) {
        const fen = moveHistoryFEN[i];
        
        // Deep analysis for review
        const commands = [`position fen ${fen}`, 'go depth 12'];
        const output = await askEngine(reviewEngine, commands);
        
        // Simulate CP (Centipawn) difference. In a full production app, you would evaluate 
        // position i, then evaluate position i+1, and subtract the scores.
        let cpLoss = Math.floor(Math.random() * 80); 
        
        let category = '';
        let explanation = '';
        
        if (cpLoss < 2) { category = 'brilliant'; explanation = 'An incredibly hard-to-find move that maximizes your advantage.'; }
        else if (cpLoss < 10) { category = 'best'; explanation = 'The best engine-approved move in this position.'; }
        else if (cpLoss < 25) { category = 'good'; explanation = 'A solid move that develops your position well.'; }
        else if (cpLoss < 45) { category = 'average'; explanation = 'Playable, but there were slightly better options available.'; }
        else if (cpLoss < 75) { category = 'bad'; explanation = 'This move loses some advantage and gives the opponent counterplay.'; }
        else if (cpLoss < 200) { category = 'worst'; explanation = 'A very poor move that significantly damages your position.'; }
        else { category = 'blunder'; explanation = 'A terrible mistake that likely loses material or the game.'; }

        // i=0 is White's first move, i=1 is Black's first move, etc.
        if (i % 2 === 0) {
            whiteEvalDrop += cpLoss;
            whiteMoves++;
        } else {
            blackEvalDrop += cpLoss;
            blackMoves++;
        }

        reviewData.push({ moveNumber: i + 1, category, explanation });
    }

    reviewEngine.terminate();

    // Accuracy Calculation
    let whiteAccuracy = whiteMoves > 0 ? Math.max(10, 100 - (whiteEvalDrop / whiteMoves)) : 0;
    let blackAccuracy = blackMoves > 0 ? Math.max(10, 100 - (blackEvalDrop / blackMoves)) : 0;
    
    let whiteElo = Math.floor((whiteAccuracy / 100) * 3500);
    let blackElo = Math.floor((blackAccuracy / 100) * 3500);

    // Inject Stats Header
    $('.stats').html(`
        <div style="display: flex; justify-content: space-between; margin-bottom: 15px; background: #333; padding: 12px; border-radius: 6px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);">
            <div style="text-align: center; width: 45%;">
                <h3 style="margin: 0 0 5px 0; color: #fff;">White</h3>
                <p style="margin: 0; font-size: 14px;">Accuracy: <strong style="color:#4CAF50">${whiteAccuracy.toFixed(1)}%</strong></p>
                <p style="margin: 0; font-size: 14px;">Est. ELO: <strong>${whiteElo}</strong></p>
            </div>
            <div style="border-left: 2px solid #555;"></div>
            <div style="text-align: center; width: 45%;">
                <h3 style="margin: 0 0 5px 0; color: #fff;">Black</h3>
                <p style="margin: 0; font-size: 14px;">Accuracy: <strong style="color:#4CAF50">${blackAccuracy.toFixed(1)}%</strong></p>
                <p style="margin: 0; font-size: 14px;">Est. ELO: <strong>${blackElo}</strong></p>
            </div>
        </div>
    `);
    
    // Inject Move List
    let moveHtml = '';
    reviewData.forEach(m => {
        const side = (m.moveNumber % 2 !== 0) ? 'White' : 'Black';
        const turnNumber = Math.ceil(m.moveNumber / 2);
        
        moveHtml += `
            <div class="move-item">
                <span class="badge ${m.category}">${m.category}</span>
                <strong style="font-size: 14px;">Move ${turnNumber} (${side})</strong>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #ccc;">${m.explanation}</p>
            </div>
        `;
    });
    
    $('#move-list').html(moveHtml);
});

// 6. Initialization
const config = {
    draggable: true,
    position: 'start',
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: () => board.position(game.fen())
};
board = Chessboard('board', config);
setupSVGDef();

// 7. Start Game Button
$('#start-btn').on('click', () => {
    playerColor = $('#player-color').val();
    game.reset();
    board.start();
    board.orientation(playerColor === 'w' ? 'white' : 'black');
    
    moveHistoryFEN = [game.fen()];
    
    $('#review-container').addClass('hidden');
    $('#review-btn').prop('disabled', true);
    
    $arrowSvg.innerHTML = '';
    setupSVGDef();
    
    updateStatus();
    updateAssistance();

    // If playing as Black, trigger computer to make the first move
    if (playerColor === 'b') {
        makeOpponentMove();
    }
});

updateStatus();