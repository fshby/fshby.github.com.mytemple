(() => {
  'use strict';

  const canvas = document.getElementById('neural-canvas');
  const visual = canvas?.closest('.hero-visual');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = window.matchMedia('(max-width: 640px)');
  const state = { width: 0, height: 0, dpr: 1, nodes: [], edges: [], hover: -1, pulse: 0, running: false, visible: true, raf: 0, time: 0 };

  const kinds = [
    { key: 'doc', color: '#88a956', weight: 1 },
    { key: 'sem', color: '#b2c38d', weight: 2 },
    { key: 'tag', color: '#d4c58a', weight: 1 }
  ];

  function seeded(seed) {
    let value = seed;
    return () => {
      value = (value * 1664525 + 1013904223) % 4294967296;
      return value / 4294967296;
    };
  }

  function createGraph() {
    const random = seeded(20260723);
    const count = mobile.matches ? 42 : 72;
    state.nodes = Array.from({ length: count }, (_, i) => {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * 0.42;
      const kind = i < 13 ? kinds[i % kinds.length] : kinds[Math.floor(random() * kinds.length)];
      return {
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.52 + Math.sin(angle) * radius * 0.76,
        vx: (random() - .5) * .00011,
        vy: (random() - .5) * .00011,
        phase: random() * Math.PI * 2,
        r: 1.9 + random() * (kind.key === 'doc' ? 2.2 : 1.7),
        kind
      };
    });
    state.edges = [];
    state.nodes.forEach((node, i) => {
      const neighbors = state.nodes.map((other, j) => ({ j, d: Math.hypot(node.x - other.x, node.y - other.y) }))
        .filter(item => item.j !== i).sort((a, b) => a.d - b.d).slice(0, i < 13 ? 4 : 2);
      neighbors.forEach(item => {
        if (item.d < .16 && !state.edges.some(edge => edge.a === item.j && edge.b === i)) state.edges.push({ a: i, b: item.j, strength: 1 - item.d / .16 });
      });
    });
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    state.width = rect.width;
    state.height = rect.height;
    state.dpr = Math.min(window.devicePixelRatio || 1, 1.35);
    canvas.width = Math.max(1, Math.floor(rect.width * state.dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * state.dpr));
  }

  function draw(now = 0) {
    if (!canvas || !state.visible) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    state.time = now;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    const points = state.nodes.map((node, i) => {
      if (!reducedMotion && state.running) {
        const wander = Math.sin(now * .00018 + node.phase) * .00008;
        node.x += node.vx + wander;
        node.y += node.vy + Math.cos(now * .00016 + node.phase) * .00006;
        if (node.x < .08 || node.x > .92) node.vx *= -1;
        if (node.y < .12 || node.y > .9) node.vy *= -1;
      }
      return { x: node.x * state.width, y: node.y * state.height };
    });
    const active = state.hover;
    state.edges.forEach(edge => {
      const a = points[edge.a]; const b = points[edge.b];
      const related = active >= 0 && (edge.a === active || edge.b === active);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = related ? 'rgba(136,169,86,.5)' : `rgba(126,150,85,${.06 + edge.strength * .08})`;
      ctx.lineWidth = related ? 1.1 : .55;
      ctx.stroke();
    });
    state.nodes.forEach((node, i) => {
      const point = points[i]; const activeNode = i === active;
      const glow = activeNode ? 11 : 5;
      const opacity = active >= 0 && !activeNode && !state.edges.some(edge => (edge.a === active && edge.b === i) || (edge.b === active && edge.a === i)) ? .3 : .82;
      ctx.beginPath(); ctx.arc(point.x, point.y, node.r + (activeNode ? 1.8 : 0), 0, Math.PI * 2);
      ctx.fillStyle = node.kind.color; ctx.globalAlpha = opacity; ctx.shadowColor = node.kind.color; ctx.shadowBlur = glow; ctx.fill(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      if (activeNode || (state.pulse > 0 && i === Math.floor(state.pulse))) {
        ctx.beginPath(); ctx.arc(point.x, point.y, node.r + 8 + (1 - (state.time % 850) / 850) * 7, 0, Math.PI * 2);
        ctx.strokeStyle = `${node.kind.color}55`; ctx.lineWidth = 0.9; ctx.stroke();
      }
    });
    if (state.running && !reducedMotion) state.raf = requestAnimationFrame(draw);
  }

  function findNearest(event) {
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    let best = -1; let distance = 18;
    state.nodes.forEach((node, index) => { const d = Math.hypot(node.x * state.width - x, node.y * state.height - y); if (d < distance) { distance = d; best = index; } });
    return best;
  }

  function setRunning(value) {
    state.running = value && !reducedMotion && !document.hidden;
    if (state.running && !state.raf) state.raf = requestAnimationFrame(draw);
    if (!state.running && state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; draw(state.time); }
  }

  if (canvas) {
    createGraph(); resize(); draw(0);
    new ResizeObserver(() => { resize(); draw(state.time); }).observe(canvas);
    canvas.addEventListener('pointermove', event => { state.hover = findNearest(event); canvas.style.cursor = state.hover >= 0 ? 'pointer' : 'default'; draw(state.time); });
    canvas.addEventListener('pointerleave', () => { state.hover = -1; draw(state.time); });
    canvas.addEventListener('pointerdown', () => { if (state.hover >= 0) { state.pulse = state.hover; setTimeout(() => { state.pulse = 0; }, 850); draw(state.time); } });
    const observer = new IntersectionObserver(entries => { state.visible = entries[0].isIntersecting; setRunning(state.visible); }, { threshold: .05 });
    observer.observe(visual || canvas);
    document.addEventListener('visibilitychange', () => setRunning(state.visible));
  }

  const nav = document.querySelector('[data-nav]');
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const navLinks = document.querySelector('.nav-links');
  window.addEventListener('scroll', () => nav?.classList.toggle('scrolled', window.scrollY > 12), { passive: true });
  menuToggle?.addEventListener('click', () => { const open = navLinks.classList.toggle('open'); menuToggle.setAttribute('aria-expanded', String(open)); });
  navLinks?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { navLinks.classList.remove('open'); menuToggle?.setAttribute('aria-expanded', 'false'); }));

  const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); } }), { threshold: .12 });
  document.querySelectorAll('.reveal').forEach(element => revealObserver.observe(element));
  if (window.location.hash) {
    const target = document.querySelector(window.location.hash);
    target?.classList.add('is-visible');
    target?.querySelectorAll('.reveal').forEach(element => element.classList.add('is-visible'));
    requestAnimationFrame(() => target?.scrollIntoView({ block: 'start' }));
  }
  const year = document.querySelector('[data-year]'); if (year) year.textContent = new Date().getFullYear();
})();
