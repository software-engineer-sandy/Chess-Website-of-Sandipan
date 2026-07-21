let board = null;
let game = new Chess();
let moveHistoryFEN = [];
let playerColor = 'w';

// Global Data for the Review Page
let globalReviewData = [];
let currentReviewIndex = 0;
let matchAccuracy = { w: { drop: 0, moves: 0 }, b: { drop: 0, moves: 0 } };

const $status = $('#status');
const $arrowSvg = document.getElementById('arrow-svg');

// 1. Web Worker Setup (Local Stockfish Engine)
function createEngine() {
    // Points directly to the file in your GitHub repository
    return new Worker('stockfish.js');
}

// 4 Dedicated Workers to prevent command overlap
const mainEngine = createEngine();    // Plays the computer moves
const evalWorker = createEngine();    // Live evaluation bar 
const assistWorker = createEngine();  // Assistance mode arrows
const reviewEngine = createEngine();  // On-demand post-match review

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

// 2. Real-Time Probabilities (Win %)
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

// 3. UI & SVG Rendering
function updateStatus() {
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

// 4. Assistance Engine (Real Stockfish MultiPV)
async function updateAssistance() {
    $arrowSvg.innerHTML = '';
    setupSVGDef();
    
    if ($('#assistance').val() === 'off' || game.game_over()) return;
    if (game.turn() !== playerColor) return;

    const currentFen = game.fen();

    const playerCommands = [
        'uci', 'setoption name MultiPV value 3', `position fen ${currentFen}`, 'go depth 10'
    ];
    const playerOutput = await askEngine(assistWorker, playerCommands);
    
    // Simulate opponent's perspective to uncover direct threats
    let fenTokens = currentFen.split(' ');
    fenTokens[1] = fenTokens[1] === 'w' ? 'b' : 'w'; 
    fenTokens[3] = '-'; // strip en passant targets to prevent illegal FEN
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

// 5. Opponent Logic (Stockfish calculating best move strictly by ELO)
async function makeOpponentMove() {
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

function onDragStart(source, piece, position, orientation) {
    if (game.game_over()) return false;
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
        $('#review-btn').prop('disabled', false);
        return;
    }
    makeOpponentMove();
}

// 6. Interactive Match Review Setup
function getFormalMoveName(moveObj) {
    const color = moveObj.color === 'w' ? 'White' : 'Black';
    const pieces = { p: '', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
    const piece = pieces[moveObj.piece];
    const square = moveObj.to.toUpperCase();

    if (moveObj.san === 'O-O') return `${color} King (Kingside Castle)`;
    if (moveObj.san === 'O-O-O') return `${color} King (Queenside Castle)`;

    return `${color} ${piece} ${square}`.trim().replace(/\s+/g, ' ');
}

function updateReviewStats() {
    let whiteAccuracy = matchAccuracy.w.moves > 0 ? Math.max(10, 100 - (matchAccuracy.w.drop / matchAccuracy.w.moves)) : 100;
    let blackAccuracy = matchAccuracy.b.moves > 0 ? Math.max(10, 100 - (matchAccuracy.b.drop / matchAccuracy.b.moves)) : 100;
    
    let whiteElo = Math.floor((whiteAccuracy / 100) * 3500);
    let blackElo = Math.floor((blackAccuracy / 100) * 3500);

    $('.review-stats').html(`
        <div style="display: flex; justify-content: space-between; background: #333; padding: 12px; border-radius: 6px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);">
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
}

$('#review-btn').on('click', () => {
    $('#game-setup-page').addClass('hidden');
    $('#review-play-page').removeClass('hidden');
    
    // Instantly load the review page; evaluate on demand.
    $('#review-loading').addClass('hidden');
    $('#review-play-content').removeClass('hidden');
    $arrowSvg.innerHTML = '';
    
    globalReviewData = [];
    matchAccuracy = { w: { drop: 0, moves: 0 }, b: { drop: 0, moves: 0 } };
    
    globalReviewData.push({
        fen: moveHistoryFEN[0],
        moveName: "Start Position",
        category: "start",
        explanation: "The game begins.",
        evaluated: false
    });
    
    const fullHistory = game.history({ verbose: true });
    
    for (let i = 0; i < fullHistory.length; i++) {
        globalReviewData.push({
            fen: moveHistoryFEN[i + 1],
            moveName: getFormalMoveName(fullHistory[i]),
            evaluated: false
        });
    }

    updateReviewStats();
    board.position(globalReviewData[0].fen, false); 
    currentReviewIndex = globalReviewData.length > 1 ? 1 : 0;
    
    setTimeout(() => {
        applyReviewMoveUI();
    }, 100); 
});

async function getAbsoluteEval(fen) {
    // Send only the currently viewed board FEN and wait a fraction of a sec.
    const output = await askEngine(reviewEngine, [`position fen ${fen}`, 'go movetime 200']);
    let cp = 0;
    
    output.forEach(line => {
        if (line.includes('score cp')) {
            const match = line.match(/score cp (-?\d+)/);
            if (match) cp = parseInt(match[1], 10);
        } else if (line.includes('score mate')) {
            const match = line.match(/score mate (-?\d+)/);
            if (match) cp = parseInt(match[1], 10) > 0 ? 10000 : -10000;
        }
    });
    
    // Standardize score to an absolute value for precise centipawn loss checks
    return fen.includes(' w ') ? cp : -cp;
}

async function applyReviewMoveUI() {
    const data = globalReviewData[currentReviewIndex];
    board.position(data.fen, true); 
    
    $('#review-move-title').text(data.moveName);
    
    // Lock navigation briefly whilst calculation is occurring 
    $('#btn-prev-move').prop('disabled', currentReviewIndex === 0);
    $('#btn-next-move').prop('disabled', true);

    if (!data.evaluated) {
        $('#review-move-badge').text('ANALYZING...').attr('class', 'badge start');
        $('#review-move-desc').text('Stockfish is evaluating this position...');
        
        let prevData = globalReviewData[currentReviewIndex - 1];
        
        // Grab evaluation for the immediate previous frame if not computed
        if (prevData && prevData.eval === undefined) {
            prevData.eval = await getAbsoluteEval(prevData.fen);
        }

        data.eval = await getAbsoluteEval(data.fen);

        if (prevData) {
            let playerWhoMoved = prevData.fen.includes(' w ') ? 'w' : 'b';
            
            // Calculate exact cp loss relying on the perspective
            let cpLoss = (prevData.eval - data.eval) * (playerWhoMoved === 'w' ? 1 : -1);
            cpLoss = Math.max(0, cpLoss); // Prevent negative "better than best engine move" outputs

            if (cpLoss < 10) { data.category = 'best'; data.explanation = 'The best engine-approved move in this position.'; }
            else if (cpLoss < 25) { data.category = 'good'; data.explanation = 'A solid move that develops your position well.'; }
            else if (cpLoss < 50) { data.category = 'average'; data.explanation = 'Playable, but there were slightly better options available.'; }
            else if (cpLoss < 100) { data.category = 'bad'; data.explanation = 'This move loses some advantage and gives the opponent counterplay.'; }
            else if (cpLoss < 300) { data.category = 'worst'; data.explanation = 'A very poor move that significantly damages your position.'; }
            else { data.category = 'blunder'; data.explanation = 'A terrible mistake that likely loses material or the game.'; }

            matchAccuracy[playerWhoMoved].drop += cpLoss;
            matchAccuracy[playerWhoMoved].moves++;
            updateReviewStats();
        } else {
            data.category = 'start';
            data.explanation = 'The game begins.';
        }
        data.evaluated = true;
    }

    $('#review-move-badge').text(data.category).attr('class', `badge ${data.category}`);
    $('#review-move-desc').text(data.explanation);

    // Re-enable "Next" 
    $('#btn-next-move').prop('disabled', currentReviewIndex === globalReviewData.length - 1);
}

$('#btn-next-move').on('click', () => {
    if (currentReviewIndex < globalReviewData.length - 1) {
        currentReviewIndex++;
        applyReviewMoveUI();
    }
});

$('#btn-prev-move').on('click', () => {
    if (currentReviewIndex > 0) {
        currentReviewIndex--;
        applyReviewMoveUI();
    }
});

$('#btn-exit-review').on('click', () => {
    $('#review-play-page').addClass('hidden');
    $('#game-setup-page').removeClass('hidden');
    board.position(game.fen(), false); 
    updateAssistance();
});

// 7. Initialization
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

// 8. Start Game Button
$('#start-btn').on('click', () => {
    playerColor = $('#player-color').val();
    game.reset();
    board.start();
    board.orientation(playerColor === 'w' ? 'white' : 'black');
    
    moveHistoryFEN = [game.fen()];
    $('#review-btn').prop('disabled', true);
    $arrowSvg.innerHTML = '';
    setupSVGDef();
    
    updateStatus();
    updateAssistance();

    if (playerColor === 'b') {
        makeOpponentMove();
    }
});

updateStatus();