// Data retrieved from gameplay session
const moveHistoryFEN = JSON.parse(sessionStorage.getItem('moveHistoryFEN') || "[]");
const fullHistory = JSON.parse(sessionStorage.getItem('fullHistory') || "[]");
const playerColor = sessionStorage.getItem('playerColor') || 'w';

// If navigated here directly without playing a game, redirect back.
if (moveHistoryFEN.length === 0) {
    window.location.href = 'index.html';
}

let board = null;
let globalReviewData = [];
let currentReviewIndex = 0;
let matchAccuracy = { w: { drop: 0, moves: 0 }, b: { drop: 0, moves: 0 } };

const reviewEngine = new Worker('stockfish.js');

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

async function getAbsoluteEval(fen) {
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
    
    return fen.includes(' w ') ? cp : -cp;
}

async function applyReviewMoveUI() {
    const data = globalReviewData[currentReviewIndex];
    board.position(data.fen, true); 
    
    $('#review-move-title').text(data.moveName);
    
    $('#btn-prev-move').prop('disabled', currentReviewIndex === 0);
    $('#btn-next-move').prop('disabled', true);

    if (!data.evaluated) {
        $('#review-move-badge').text('ANALYZING...').attr('class', 'badge start');
        $('#review-move-desc').text('Stockfish is evaluating this position...');
        
        let prevData = globalReviewData[currentReviewIndex - 1];
        
        if (prevData && prevData.eval === undefined) {
            prevData.eval = await getAbsoluteEval(prevData.fen);
        }

        data.eval = await getAbsoluteEval(data.fen);

        if (prevData) {
            let playerWhoMoved = prevData.fen.includes(' w ') ? 'w' : 'b';
            
            const getEP = (cp) => 100 / (1 + Math.pow(10, -cp / 400));
            
            let prevCP = playerWhoMoved === 'w' ? prevData.eval : -prevData.eval;
            let currCP = playerWhoMoved === 'w' ? data.eval : -data.eval;
            
            let prevEP = getEP(prevCP);
            let currEP = getEP(currCP);
            
            let epLoss = Math.max(0, prevEP - currEP); 

            const getMaterial = (fenStr) => {
                const values = { 'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9 };
                let w = 0, b = 0;
                const boardPart = fenStr.split(' ')[0];
                for (let char of boardPart) {
                    if (values[char.toLowerCase()]) {
                        if (char === char.toUpperCase()) w += values[char.toLowerCase()];
                        else b += values[char.toLowerCase()];
                    }
                }
                return { w, b };
            };

            let prevMat = getMaterial(prevData.fen);
            let currMat = getMaterial(data.fen);
            
            let isSacrifice = false;
            if (playerWhoMoved === 'w' && (currMat.w - currMat.b) < (prevMat.w - prevMat.b)) isSacrifice = true;
            if (playerWhoMoved === 'b' && (currMat.b - currMat.w) < (prevMat.b - prevMat.w)) isSacrifice = true;

            let isBook = currentReviewIndex <= 10;

            if (isBook && epLoss < 3) { 
                data.category = 'book'; 
                data.explanation = 'Book: A recognized, standard opening move derived from established theory.'; 
            } else if (isSacrifice && epLoss < 2 && currentReviewIndex > 10) { 
                data.category = 'brilliant'; 
                data.explanation = 'Brilliant: A rare, strong sacrifice played in a situation where a safer alternative existed, leading to a winning or highly advantageous position.'; 
            } else if (epLoss < 2 && prevEP < 40 && currEP > 20) { 
                data.category = 'great'; 
                data.explanation = 'Great: The only move in a position that keeps you in the game; missing it causes your position to collapse.'; 
            } else if (epLoss < 2) { 
                data.category = 'best'; 
                data.explanation = 'Best: The top engine choice, or among the top choices of equal value.'; 
            } else if (epLoss < 5) { 
                data.category = 'excellent'; 
                data.explanation = 'Excellent: A great move that is nearly as strong as the "Best" move, but slightly less optimal.'; 
            } else if (epLoss < 10) { 
                data.category = 'good'; 
                data.explanation = 'Good: A decent, sound move that doesn\'t put you at a disadvantage but isn\'t the most critical or precise.'; 
            } else if (epLoss < 20) { 
                data.category = 'inaccuracy'; 
                data.explanation = 'Inaccuracy: A slightly weak move that makes your position fractionally worse.'; 
            } else if (epLoss < 30) { 
                data.category = 'mistake'; 
                data.explanation = 'Mistake: A distinctly bad move that makes a noticeable negative impact on your position.'; 
            } else if (epLoss >= 30 && prevEP > 60 && currEP < 50) { 
                data.category = 'miss'; 
                data.explanation = 'Miss: Failing to capitalize on a tactical opportunity or a missed win.'; 
            } else { 
                data.category = 'blunder'; 
                data.explanation = 'Blunder: A terrible move that drastically worsens your position and usually results in losing material.'; 
            }

            matchAccuracy[playerWhoMoved].drop += epLoss;
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

    $('#btn-next-move').prop('disabled', currentReviewIndex === globalReviewData.length - 1);
}

// Start sequence for review page
$(document).ready(() => {
    // Basic config for the purely visual board in review
    const config = {
        draggable: false,
        position: 'start',
        pieceTheme: 'img/chesspieces/wikipedia/{piece}.png'
    };
    board = Chessboard('board', config);
    board.orientation(playerColor === 'w' ? 'white' : 'black');
    
    $('#review-loading').addClass('hidden');
    $('#review-play-content').removeClass('hidden');
    
    globalReviewData.push({
        fen: moveHistoryFEN[0],
        moveName: "Start Position",
        category: "start",
        explanation: "The game begins.",
        evaluated: false
    });
    
    for (let i = 0; i < fullHistory.length; i++) {
        globalReviewData.push({
            fen: moveHistoryFEN[i + 1],
            moveName: getFormalMoveName(fullHistory[i]),
            evaluated: false
        });
    }

    updateReviewStats();
    currentReviewIndex = globalReviewData.length > 1 ? 1 : 0;
    
    setTimeout(() => {
        applyReviewMoveUI();
    }, 100);
});

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
    window.location.href = 'index.html';
});