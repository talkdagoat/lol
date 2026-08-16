export function renderLanding(onGetStarted) {
  return `
  <nav class="landing-nav" id="landing-nav">
    <div class="landing-nav-logo">Talk<span>.</span></div>
    <div class="landing-nav-links">
      <a href="#people">People</a>
      <a href="#calls">Calls</a>
      <a href="#chat">Chat</a>
      <a href="#games">Games</a>
      <button class="btn-primary" id="nav-cta">Get Started</button>
    </div>
  </nav>

  <section class="landing-hero">
    <div class="landing-hero-content">
      <h1>Connect. Chat. <span class="gradient">Play.</span></h1>
      <p>Talk brings your contacts, conversations, and casual games into one clean, fast workspace. No clutter — just people, talking.</p>
      <div class="landing-hero-cta">
        <button class="btn-primary" id="hero-cta">Get Started Free</button>
        <button class="btn-outline" id="hero-learn">Learn More</button>
      </div>
      <div class="landing-hero-stats">
        <div class="landing-hero-stat"><div class="landing-hero-stat-num">4</div><div class="landing-hero-stat-label">Sections</div></div>
        <div class="landing-hero-stat"><div class="landing-hero-stat-num">5</div><div class="landing-hero-stat-label">Games</div></div>
        <div class="landing-hero-stat"><div class="landing-hero-stat-num">100%</div><div class="landing-hero-stat-label">Free</div></div>
      </div>
    </div>
  </section>

  <section class="landing-section" id="people">
    <div class="landing-section-header">
      <span class="landing-section-tag">People</span>
      <h2>Your contacts, organized</h2>
      <p>Add people by email, search your list instantly, and start a conversation with one click. Contacts sync automatically across sessions.</p>
    </div>
    <div class="landing-features">
      <div class="feature-card">
        <div class="feature-card-icon blue">👥</div>
        <h3>Add by Email</h3>
        <p>Add anyone to your contacts with just their email address. No phone numbers required.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon green">🔍</div>
        <h3>Instant Search</h3>
        <p>Filter your contact list in real time as you type. Find the right person in seconds.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon sky">💬</div>
        <h3>One-Click Chat</h3>
        <p>Jump straight into a conversation from any contact card. No friction, no extra steps.</p>
      </div>
    </div>
  </section>

  <section class="landing-section" id="calls">
    <div class="landing-section-header">
      <span class="landing-section-tag">Calls</span>
      <h2>Crystal-clear voice calls</h2>
      <p>Call any contact directly from your list. Talk keeps it simple — click, connect, converse.</p>
    </div>
    <div class="landing-features">
      <div class="feature-card">
        <div class="feature-card-icon sky">📞</div>
        <h3>Direct Calling</h3>
        <p>Start a call from any contact card. No dial pad, no complications — just a button.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon blue">🔔</div>
        <h3>Call Notifications</h3>
        <p>Get alerted instantly when someone is trying to reach you. Never miss a conversation.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon green">📡</div>
        <h3>Reliable Connection</h3>
        <p>Built on Firebase infrastructure for stable, low-latency voice connections.</p>
      </div>
    </div>
  </section>

  <section class="landing-section" id="chat">
    <div class="landing-section-header">
      <span class="landing-section-tag">Chat</span>
      <h2>Real-time messaging</h2>
      <p>Messages appear instantly, powered by Firestore. Your conversations stay in sync across every device.</p>
    </div>
    <div class="landing-features">
      <div class="feature-card">
        <div class="feature-card-icon blue">⚡</div>
        <h3>Instant Delivery</h3>
        <p>Messages sync in real time via Firestore listeners. No refresh needed — they just appear.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon green">🔒</div>
        <h3>Private & Secure</h3>
        <p>Each conversation is stored privately. Only you and your contact can see the messages.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon amber">📜</div>
        <h3>Message History</h3>
        <p>Your conversations persist across sessions. Pick up right where you left off, anytime.</p>
      </div>
    </div>
  </section>

  <section class="landing-section" id="games">
    <div class="landing-section-header">
      <span class="landing-section-tag">Games</span>
      <h2>Play between conversations</h2>
      <p>Take a break with five games built right in. No pressure — just play.</p>
    </div>
    <div class="landing-features">
      <div class="feature-card">
        <div class="feature-card-icon amber">⭕</div>
        <h3>Tic-Tac-Toe</h3>
        <p>The classic 3x3 grid. Play as X against a simple AI opponent. Quick rounds, instant restarts.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon sky">🃏</div>
        <h3>Memory Match</h3>
        <p>Flip cards and find matching pairs. Track your moves and time as you improve your memory.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon sky">🚀</div>
        <h3>Space Shooter</h3>
        <p>Blast through waves of alien invaders and rack up points in this arcade classic.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon green">👾</div>
        <h3>Gap Jumper</h3>
        <p>Time your jumps perfectly to clear the gaps and go the distance.</p>
      </div>
      <div class="feature-card">
        <div class="feature-card-icon blue">🕹️</div>
        <h3>Dodger</h3>
        <p>Dodge the red blocks, collect yellow coins, and survive as long as you can.</p>
      </div>
    </div>
  </section>

  <section class="landing-cta">
    <div class="landing-cta-box">
      <h2>Ready to Talk?</h2>
      <p>Sign up free and start connecting with your people today.</p>
      <button id="cta-final">Create Your Free Account</button>
    </div>
  </section>

  <footer class="landing-footer">
    <p>Talk &copy; 2026 — Connect. Chat. Play.</p>
  </footer>
  `;
}

export function attachLandingEvents(onGetStarted) {
  const nav = document.getElementById('landing-nav');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 10);
  });

  ['nav-cta', 'hero-cta', 'cta-final'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', onGetStarted);
  });

  const learnMore = document.getElementById('hero-learn');
  if (learnMore) {
    learnMore.addEventListener('click', () => {
      document.getElementById('people').scrollIntoView({ behavior: 'smooth' });
    });
  }
}
