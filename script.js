// Enhanced Flashcard app with spaced repetition, deck locking, and advanced features
let allWords = [];       // full 5000 list (frequency-ordered from ML_max)
let remainingWords = []; // words not yet in openDeck
let openDeck = [];       // current open deck (80 cards)
let completeDeck = [];  // words moved here after mastery
let sentences = [];
let mastery = {};       // mastery[spanish] = {s2e: n, e2s: n}
let sentenceMastery = {}; // sentence index -> correct count
let completedSentences = new Set();

// Streaks
let streak = 0;
let bestStreak = 0;
let unlockStreak = 0;   // streak for unlocking open deck (complete deck only)

// Game state
let currentGame = null; // {type: 'open'|'complete'|'sentence', pool: [], mode: 'spanish'|'english'|'random', ...}

// Constants
const REQUIRED_PER_DIRECTION = 5; // 5 correct in each direction
const OPEN_DECK_SIZE = 80;
const LOCK_MILESTONE = 50; // lock every 50 mastered cards
const UNLOCK_STREAK_REQUIRED = 100;

// Spaced Repetition System
let srsData = {}; // srsData[spanish] = {lastReview: timestamp, interval: days, ease: number}

// Timer
let sessionStartTime = null;
let sessionTimer = null;
let lockoutTimer = null;
let lockoutEndTime = null;
let isLockedOut = false;

// Browser lockout state
let lockoutDuration = null; // minutes

// Notification system
let notificationTimeout = null;

// Load and initialize
async function loadData(){
  try {
    allWords = await fetch('words.json').then(r=>r.json());
    sentences = await fetch('sentences.json').then(r=>r.json());
  } catch(e) {
    console.error('Error loading data:', e);
    allWords = [];
    sentences = [];
  }

  // Use first 80 words from frequency-ordered list (no shuffle initially)
  const initial = allWords.slice(0, OPEN_DECK_SIZE).map((w,i)=>({ id:i, ...w }));
  openDeck = initial;
  remainingWords = allWords.slice(OPEN_DECK_SIZE).map((w,i)=>({ id: OPEN_DECK_SIZE + i, ...w }));

  // Initialize mastery records
  openDeck.concat(remainingWords).forEach(w => {
    if(w && w.spanish) {
      mastery[w.spanish] = mastery[w.spanish] || { s2e: 0, e2s: 0 };
      srsData[w.spanish] = srsData[w.spanish] || { lastReview: null, interval: 1, ease: 2.5 };
    }
  });

  // Load saved state
  loadState();
  updateCounters();
  updateLockStatus();
  checkLockoutState();
}

function shuffle(a){ 
  for(let i=a.length-1;i>0;i--){
    let j=Math.floor(Math.random()*(i+1)); 
    [a[i],a[j]]=[a[j],a[i]];
  } 
  return a; 
}

function normalize(s){
  if(!s) return '';
  s = s.toLowerCase().trim();
  s = s.replace(/[¿?¡!.,;:()"'`-]/g,'');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/\s+/g,' ').trim();
  return s;
}

function updateCounters(){
  const completeCountEl = document.getElementById('completeCount');
  const sentencesUnlockedEl = document.getElementById('sentencesUnlocked');
  const sentencesMasteredEl = document.getElementById('sentencesMastered');
  const streakCounterEl = document.getElementById('streakCounter');
  const streakValueEl = document.getElementById('streakValue');
  const bestStreakValueEl = document.getElementById('bestStreakValue');
  const unlockStreakEl = document.getElementById('unlockStreak');
  const unlockStreakValueEl = document.getElementById('unlockStreakValue');
  
  if(completeCountEl) completeCountEl.innerText = completeDeck.length;
  if(sentencesUnlockedEl) sentencesUnlockedEl.innerText = completedSentences.size;
  let mastered = 0;
  for(let sid in sentenceMastery) if(sentenceMastery[sid] && sentenceMastery[sid] >= REQUIRED_PER_DIRECTION) mastered++;
  if(sentencesMasteredEl) sentencesMasteredEl.innerText = mastered;
  if(streakCounterEl) streakCounterEl.textContent = streak;
  if(streakValueEl) streakValueEl.textContent = streak;
  if(bestStreakValueEl) bestStreakValueEl.textContent = bestStreak;
  if(unlockStreakEl) unlockStreakEl.textContent = unlockStreak;
  if(unlockStreakValueEl) unlockStreakValueEl.textContent = unlockStreak;
  
  updateLockStatus();
}

function updateLockStatus(){
  const isLocked = isOpenDeckLocked();
  const startOpenBtn = document.getElementById('startOpen');
  const lockStatusEl = document.getElementById('lockStatus');
  const unlockStreakContainer = document.getElementById('unlockStreakContainer');
  
  if(startOpenBtn) {
    startOpenBtn.disabled = isLocked;
    if(isLocked) {
      startOpenBtn.style.opacity = '0.5';
      startOpenBtn.style.cursor = 'not-allowed';
    } else {
      startOpenBtn.style.opacity = '1';
      startOpenBtn.style.cursor = 'pointer';
    }
  }
  
  if(lockStatusEl) {
    if(isLocked) {
      lockStatusEl.innerHTML = `🔒 Open deck locked! Achieve ${UNLOCK_STREAK_REQUIRED}-streak in Complete Deck to unlock.`;
      lockStatusEl.style.color = '#ff6d6d';
    } else {
      lockStatusEl.innerHTML = '';
    }
  }
  
  // Show unlock streak counter when locked
  if(unlockStreakContainer) {
    unlockStreakContainer.style.display = isLocked ? 'block' : 'none';
  }
}

function isOpenDeckLocked(){
  return completeDeck.length > 0 && completeDeck.length % LOCK_MILESTONE === 0;
}

function calculateWeakness(card){
  const m = mastery[card.spanish] || { s2e: 0, e2s: 0 };
  return (REQUIRED_PER_DIRECTION * 2) - (m.s2e + m.e2s);
}

function weightedRandomSelect(pool){
  // Calculate weights based on weakness
  const weights = pool.map(card => {
    const weakness = calculateWeakness(card);
    return Math.max(1, 1 + (weakness * 2)); // base weight + weakness multiplier
  });
  
  // Calculate total weight
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  
  // Select random point
  let random = Math.random() * totalWeight;
  
  // Find which card this corresponds to
  for(let i = 0; i < pool.length; i++){
    random -= weights[i];
    if(random <= 0) return i;
  }
  
  return pool.length - 1;
}

function startGame(type){
  if(type === 'open' && isOpenDeckLocked()){
    alert(`Open deck is locked! Achieve ${UNLOCK_STREAK_REQUIRED} consecutive correct answers in the Complete Deck to unlock.`);
    return;
  }
  
  const baseMode = document.getElementById('mode').value;
  let mode = baseMode;
  if(mode === 'random'){
    // direction chosen per-card later
    mode = Math.random() < 0.5 ? 'spanish' : 'english';
  }
  
  currentGame = {type, mode, baseMode, pool: [], originalPool: []};
  
  // Show/hide unlock streak bubble
  const unlockStreakBubble = document.getElementById('unlockStreakBubble');
  const unlockStreakContainer = document.getElementById('unlockStreakContainer');
  if(type === 'complete' && isOpenDeckLocked()){
    if(unlockStreakBubble) unlockStreakBubble.style.display = 'block';
    if(unlockStreakContainer) unlockStreakContainer.style.display = 'block';
  } else {
    if(unlockStreakBubble) unlockStreakBubble.style.display = 'none';
    if(unlockStreakContainer) unlockStreakContainer.style.display = 'none';
  }
  
  if(type === 'open') {
    // Create pool with weakness-based ordering
    currentGame.originalPool = openDeck.slice().map(w => ({...w}));
    currentGame.pool = currentGame.originalPool.slice();
    
    // Calculate weakness for each card
    currentGame.pool.forEach(card => {
      card.weakness = calculateWeakness(card);
    });
  }
  else if(type === 'complete') {
    currentGame.pool = shuffle(completeDeck.slice());
    currentGame.originalPool = currentGame.pool.slice();
  }
  else if(type === 'sentence') {
    const unlocked = [];
    sentences.forEach((s,idx) => {
      const wordsInS = extractWordsFromSentence(s.spanish);
      const allInComplete = wordsInS.every(w=>completeDeck.find(cd=>normalize(cd.spanish)===normalize(w)));
      if(allInComplete) unlocked.push({s,idx});
    });
    
    if(unlocked.length === 0){ 
      alert('No unlocked sentences yet. Earn words into the complete deck to unlock sentences.'); 
      return; 
    }
    
    const pick = unlocked[Math.floor(Math.random()*unlocked.length)];
    currentGame.pool = [{sentence: pick.s, sid: pick.idx}];
    currentGame.originalPool = currentGame.pool.slice();
  }
  
  if(currentGame.pool.length === 0){ 
    alert('No cards in this deck.'); 
    return; 
  }
  
  // Start session timer
  sessionStartTime = Date.now();
  updateSessionTimer();
  sessionTimer = setInterval(updateSessionTimer, 1000);
  
  document.getElementById('controls').hidden = true;
  document.getElementById('game').hidden = false;
  nextCard();
}

function extractWordsFromSentence(sent){
  return sent.replace(/[¿?¡!.,;]/g,'').split(/\s+/).filter(Boolean);
}

function nextCard(){
  document.getElementById('answer').value = '';
  document.getElementById('feedback').innerText = '';
  document.getElementById('feedback').className = '';
  document.getElementById('weakWordIndicator').style.display = 'none';
  
  // Determine card-specific mode if baseMode is random
  if(currentGame && currentGame.baseMode === 'random'){
    currentGame.mode = Math.random() < 0.5 ? 'spanish' : 'english';
  }
  
  if(!currentGame || currentGame.pool.length === 0){ 
    endGame(); 
    return; 
  }
  
  let card;
  if(currentGame.type === 'open' && currentGame.pool.length > 0){
    // Use weighted random selection for open deck
    const index = weightedRandomSelect(currentGame.pool);
    card = currentGame.pool.splice(index, 1)[0];
    
    // Show weak word indicator if applicable
    if(card.weakness > 0){
      document.getElementById('weakWordIndicator').style.display = 'block';
      document.getElementById('weakWordIndicator').innerText = `⚠️ Weak word - focus!`;
    }
  } else {
    card = currentGame.pool.pop();
  }
  
  currentGame.currentCard = card;
  
  if(currentGame.type === 'sentence'){
    document.getElementById('prompt').innerText = card.sentence.spanish;
    document.getElementById('answer').placeholder = 'Type the English translation and press Enter';
    document.getElementById('answer').onkeydown = async (e)=>{ if(e.key==='Enter'){ await checkSentenceAnswer(card);} }
  } else {
    const mode = currentGame.mode;
    const prompt = (mode === 'spanish') ? card.spanish : card.english;
    document.getElementById('prompt').innerText = prompt;
    document.getElementById('answer').placeholder = (mode === 'spanish') ? 'Type English translation and press Enter' : 'Type Spanish translation and press Enter';
    document.getElementById('answer').onkeydown = async (e)=>{ if(e.key==='Enter'){ await checkWordAnswer(card);} }
  }
  
  document.getElementById('answer').focus();
}

async function checkWordAnswer(card){
  const mode = currentGame.mode;
  const userRaw = document.getElementById('answer').value.trim();
  const user = userRaw.toLowerCase();
  const correctRaw = (mode === 'spanish') ? card.english : card.spanish;
  const accepted = correctRaw.split(';').map(s=>s.trim().toLowerCase());
  
  const isCorrect = accepted.some(a => a === user);
  
  if(isCorrect){
    document.getElementById('feedback').innerText = 'Correct!';
    document.getElementById('feedback').className = 'correct';
    
    streak++;
    if(currentGame.type === 'complete'){
      unlockStreak++;
      if(unlockStreak >= UNLOCK_STREAK_REQUIRED && isOpenDeckLocked()){
        unlockOpenDeck();
      }
    }
    
    document.getElementById("streakCounter").textContent = streak;
    document.getElementById("streakValue").textContent = streak;
    if (streak > bestStreak) {
      bestStreak = streak;
      document.getElementById("bestStreakValue").textContent = bestStreak;
    }
    
    // Update unlock streak display
    const unlockStreakValueEl = document.getElementById('unlockStreakValue');
    if(unlockStreakValueEl) unlockStreakValueEl.textContent = unlockStreak;
    
    // Update directional mastery
    const m = mastery[card.spanish] = mastery[card.spanish] || { s2e: 0, e2s: 0 };
    if(mode === 'spanish'){
      m.s2e = Math.min(REQUIRED_PER_DIRECTION, m.s2e + 1);
    } else {
      m.e2s = Math.min(REQUIRED_PER_DIRECTION, m.e2s + 1);
    }
    
    // Update SRS
    updateSRS(card.spanish, true);
    
    // Check if mastered (both directions)
    if(m.s2e >= REQUIRED_PER_DIRECTION && m.e2s >= REQUIRED_PER_DIRECTION &&
       !completeDeck.find(c => c.spanish === card.spanish)) {
      
      // Move to complete deck
      completeDeck.push(card);
      
      // Remove from open deck
      openDeck = openDeck.filter(x => x.spanish !== card.spanish);
      
      // Add new word if available
      if (remainingWords.length > 0) {
        const nextWord = remainingWords.shift();
        openDeck.push(nextWord);
        mastery[nextWord.spanish] = mastery[nextWord.spanish] || { s2e: 0, e2s: 0 };
        srsData[nextWord.spanish] = srsData[nextWord.spanish] || { lastReview: null, interval: 1, ease: 2.5 };
        
        // Show notification
        showNewCardNotification(nextWord);
      }
      
      updateCounters();
      saveState();
    }
  } else {
    document.getElementById('feedback').innerText = `Not quite. Correct answer: ${correctRaw}`;
    document.getElementById('feedback').className = 'wrong';
    
    // Penalize mastery
    const m = mastery[card.spanish] = mastery[card.spanish] || { s2e: 0, e2s: 0 };
    if(mode === 'spanish'){
      m.s2e = Math.max(0, m.s2e - 1);
    } else {
      m.e2s = Math.max(0, m.e2s - 1);
    }
    
    // Update SRS
    updateSRS(card.spanish, false);
    
    streak = 0;
    if(currentGame.type === 'complete'){
      unlockStreak = 0;
      const unlockStreakValueEl = document.getElementById('unlockStreakValue');
      if(unlockStreakValueEl) unlockStreakValueEl.textContent = 0;
    }
    document.getElementById("streakCounter").textContent = 0;
    document.getElementById("streakValue").textContent = 0;
    
    // Shuffle pool back (like spanish_flashcards_site)
    if(currentGame.type === 'open' && currentGame.originalPool.length > 0){
      // Put card back into pool
      currentGame.pool.push(card);
      // Shuffle the pool
      currentGame.pool = shuffle(currentGame.pool);
    }
  }
  
  saveState();
  setTimeout(()=> nextCard(), 700);
}

function updateSRS(spanish, isCorrect){
  const srs = srsData[spanish] = srsData[spanish] || { lastReview: null, interval: 1, ease: 2.5 };
  const now = Date.now();
  
  if(isCorrect){
    if(srs.lastReview === null){
      srs.interval = 1; // First review: 1 day
    } else {
      srs.interval = Math.round(srs.interval * srs.ease);
      srs.ease = Math.min(2.5, srs.ease + 0.1); // Increase ease
    }
  } else {
    srs.interval = Math.max(1, Math.round(srs.interval * 0.5)); // Halve interval
    srs.ease = Math.max(1.3, srs.ease - 0.15); // Decrease ease
  }
  
  srs.lastReview = now;
}

async function checkSentenceAnswer(card){
  const user = document.getElementById('answer').value.trim().toLowerCase();
  const correct = card.sentence.english.trim().toLowerCase();
  
  if(user === correct){
    document.getElementById('feedback').innerText = 'Correct sentence!';
    document.getElementById('feedback').className = 'correct';
    sentenceMastery[card.sid] = (sentenceMastery[card.sid]||0) + 1;
  } else {
    document.getElementById('feedback').innerText = `Not quite. Correct sentence: ${card.sentence.english}`;
    document.getElementById('feedback').className = 'wrong';
    streak = 0;
    document.getElementById("streakCounter").textContent = 0;
  }
  updateCounters();
  setTimeout(()=> endGame(), 800);
}

function endGame(){
  if(sessionTimer){
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
  
  document.getElementById('controls').hidden = false;
  document.getElementById('game').hidden = true;
  currentGame = null;
  updateCounters();
  saveState();
}

function showNewCardNotification(word){
  const notification = document.getElementById('newCardNotification');
  if(notification){
    notification.innerHTML = `✨ New card added: <strong>${word.spanish}</strong> → ${word.english}`;
    notification.style.display = 'flex';
    notification.style.opacity = '1';
    
    if(notificationTimeout) clearTimeout(notificationTimeout);
    notificationTimeout = setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(()=> notification.style.display = 'none', 300);
    }, 5000);
  }
}

function updateSessionTimer(){
  if(!sessionStartTime) return;
  
  const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timerEl = document.getElementById('sessionTimer');
  
  if(timerEl){
    timerEl.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  
  // Calculate cards per minute
  if(currentGame && currentGame.originalPool){
    const cardsCompleted = currentGame.originalPool.length - currentGame.pool.length - (currentGame.currentCard ? 1 : 0);
    const cpm = cardsCompleted > 0 ? (cardsCompleted / (elapsed / 60)).toFixed(1) : '0.0';
    const cpmEl = document.getElementById('cardsPerMinute');
    if(cpmEl) cpmEl.textContent = `${cpm} cards/min`;
  }
}

// Browser Lockout System
function startBrowserLockout(durationMinutes){
  if(!confirm(`This will lock your browser for ${durationMinutes} minutes. You can exit with Ctrl+Shift+E in an emergency. Continue?`)){
    return;
  }
  
  lockoutDuration = durationMinutes;
  lockoutEndTime = Date.now() + (durationMinutes * 60 * 1000);
  isLockedOut = true;
  
  // Enter fullscreen
  const elem = document.documentElement;
  if(elem.requestFullscreen){
    elem.requestFullscreen().catch(err => console.error('Fullscreen error:', err));
  }
  
  // Show lockout overlay
  const overlay = document.getElementById('lockoutOverlay');
  if(overlay) overlay.style.display = 'flex';
  
  // Start countdown
  updateLockoutTimer();
  lockoutTimer = setInterval(() => {
    updateLockoutTimer();
    if(Date.now() >= lockoutEndTime){
      endBrowserLockout();
    }
  }, 1000);
  
  // Prevent navigation
  window.addEventListener('beforeunload', preventNavigation);
  
  // Emergency escape
  document.addEventListener('keydown', handleEmergencyEscape);
  
  // Save lockout state
  saveState();
}

function updateLockoutTimer(){
  if(!lockoutEndTime) return;
  
  const remaining = Math.max(0, lockoutEndTime - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  
  const timerEl = document.getElementById('lockoutTimer');
  if(timerEl){
    timerEl.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
}

function handleEmergencyEscape(e){
  if(e.ctrlKey && e.shiftKey && e.key === 'E'){
    if(confirm('Emergency escape activated. Exit lockout mode?')){
      endBrowserLockout();
    }
  }
}

function preventNavigation(e){
  e.preventDefault();
  e.returnValue = '';
  return '';
}

function endBrowserLockout(){
  isLockedOut = false;
  lockoutEndTime = null;
  lockoutDuration = null;
  
  if(lockoutTimer){
    clearInterval(lockoutTimer);
    lockoutTimer = null;
  }
  
  // Exit fullscreen
  if(document.exitFullscreen){
    document.exitFullscreen();
  }
  
  // Hide overlay
  const overlay = document.getElementById('lockoutOverlay');
  if(overlay) overlay.style.display = 'none';
  
  // Remove event listeners
  window.removeEventListener('beforeunload', preventNavigation);
  document.removeEventListener('keydown', handleEmergencyEscape);
  
  saveState();
}

function checkLockoutState(){
  const saved = localStorage.getItem('lockoutEndTime');
  if(saved){
    const endTime = parseInt(saved);
    if(endTime > Date.now()){
      lockoutEndTime = endTime;
      lockoutDuration = Math.ceil((endTime - Date.now()) / 60000);
      isLockedOut = true;
      startBrowserLockout(lockoutDuration);
    } else {
      localStorage.removeItem('lockoutEndTime');
    }
  }
}

function unlockOpenDeck(){
  unlockStreak = 0;
  updateCounters();
  alert('Open deck unlocked! You achieved the required streak.');
  saveState();
}

// LocalStorage Persistence
function saveState(){
  try {
    const state = {
      openDeck: openDeck,
      completeDeck: completeDeck,
      mastery: mastery,
      sentenceMastery: Object.fromEntries(Object.entries(sentenceMastery)),
      completedSentences: Array.from(completedSentences),
      streak: streak,
      bestStreak: bestStreak,
      unlockStreak: unlockStreak,
      srsData: srsData,
      lockoutEndTime: lockoutEndTime
    };
    localStorage.setItem('flashcardState', JSON.stringify(state));
  } catch(e){
    console.error('Error saving state:', e);
  }
}

function loadState(){
  try {
    const saved = localStorage.getItem('flashcardState');
    if(saved){
      const state = JSON.parse(saved);
      
      // Migrate old mastery format if needed
      if(state.mastery){
        for(let spanish in state.mastery){
          if(typeof state.mastery[spanish] === 'number'){
            // Old format: convert to new format
            const oldCount = state.mastery[spanish];
            state.mastery[spanish] = {
              s2e: Math.min(REQUIRED_PER_DIRECTION, oldCount),
              e2s: Math.min(REQUIRED_PER_DIRECTION, oldCount)
            };
          }
        }
      }
      
      if(state.openDeck) openDeck = state.openDeck;
      if(state.completeDeck) completeDeck = state.completeDeck;
      if(state.mastery) mastery = state.mastery;
      if(state.sentenceMastery) sentenceMastery = state.sentenceMastery;
      if(state.completedSentences) completedSentences = new Set(state.completedSentences);
      if(state.streak !== undefined) streak = state.streak;
      if(state.bestStreak !== undefined) bestStreak = state.bestStreak;
      if(state.unlockStreak !== undefined) unlockStreak = state.unlockStreak;
      if(state.srsData) srsData = state.srsData;
      if(state.lockoutEndTime) lockoutEndTime = state.lockoutEndTime;
      
      // Update remainingWords to exclude words already in openDeck or completeDeck
      const usedWords = new Set();
      openDeck.forEach(w => usedWords.add(w.spanish));
      completeDeck.forEach(w => usedWords.add(w.spanish));
      remainingWords = remainingWords.filter(w => !usedWords.has(w.spanish));
    }
  } catch(e){
    console.error('Error loading state:', e);
  }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('startOpen').addEventListener('click', ()=> startGame('open'));
  document.getElementById('startComplete').addEventListener('click', ()=> startGame('complete'));
  document.getElementById('startSentence').addEventListener('click', ()=> startGame('sentence'));
  document.getElementById('quit').addEventListener('click', ()=> endGame());
  
  // Browser lockout buttons
  const lockoutButtons = document.querySelectorAll('[data-lockout-duration]');
  lockoutButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const duration = parseInt(btn.getAttribute('data-lockout-duration'));
      startBrowserLockout(duration);
    });
  });
  
  // Load data
  loadData();
});
