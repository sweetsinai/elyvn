// ==========================================
// ELYVN — Motion Graphics Engine
// Three.js + GSAP — Liquid Fluid + 3D Objects
// ==========================================

gsap.registerPlugin(ScrollTrigger);

// ==========================================
// 1. LIQUID MORPHING BACKGROUND (WebGL)
// ==========================================
(function initLiquidBackground() {
  const canvas = document.getElementById('liquid-canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener('resize', resize);

  const vsSource = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const fsSource = `
    precision highp float;
    uniform float u_time;
    uniform vec2 u_res;
    uniform vec2 u_mouse;

    float noise(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float smoothNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(noise(i), noise(i + vec2(1.0, 0.0)), u.x),
        mix(noise(i + vec2(0.0, 1.0)), noise(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * smoothNoise(p);
        p = p * 2.0 + vec2(1.7, 9.2);
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      vec2 mouse = u_mouse / u_res;
      float t = u_time * 0.12;

      vec2 q = vec2(fbm(uv + vec2(0.0, 0.0) + t), fbm(uv + vec2(5.2, 1.3) + t));
      vec2 r = vec2(fbm(uv + 4.0 * q + vec2(1.7, 9.2) + 0.15 * t), fbm(uv + 4.0 * q + vec2(8.3, 2.8) + 0.126 * t));
      float f = fbm(uv + 4.0 * r);

      // Mouse influence
      float dist = length(uv - mouse);
      f += 0.05 * smoothstep(0.4, 0.0, dist);

      // Monochromatic — very subtle white wisps on black
      float brightness = mix(0.0, 0.06, clamp(f * f * f * 3.0, 0.0, 1.0));
      gl_FragColor = vec4(vec3(brightness), 1.0);
    }
  `;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const posAttr = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(posAttr);
  gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uMouse = gl.getUniformLocation(prog, 'u_mouse');

  let mouse = { x: 0, y: 0 };
  window.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = window.innerHeight - e.clientY;
  });

  let start = performance.now();
  function draw() {
    const t = (performance.now() - start) / 1000;
    gl.uniform1f(uTime, t);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(draw);
  }
  draw();
})();

// ==========================================
// 2. THREE.JS — HERO 3D SCENE
//    Floating rings + dot grid + sphere
// ==========================================
(function initHero3D() {
  const canvas = document.getElementById('hero-3d');
  if (!canvas) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);

  function resizeHero() {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resizeHero();
  window.addEventListener('resize', resizeHero);

  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.06 });
  const matLine = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 });

  // Outer torus ring
  const torus1 = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.008, 4, 120), matLine);
  torus1.rotation.x = Math.PI / 2.2;
  scene.add(torus1);

  // Inner torus ring
  const torus2 = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.006, 4, 100), matLine);
  torus2.rotation.x = Math.PI / 1.8;
  torus2.rotation.z = 0.5;
  scene.add(torus2);

  // Third torus
  const torus3 = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.004, 4, 140), matLine);
  torus3.rotation.y = 0.3;
  scene.add(torus3);

  // Icosahedron sphere (central symbol)
  const sphere = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.5, 3),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.08 })
  );
  scene.add(sphere);

  // Dot grid (sparse)
  const dotsGeo = new THREE.BufferGeometry();
  const dotCount = 400;
  const dotPositions = new Float32Array(dotCount * 3);
  for (let i = 0; i < dotCount; i++) {
    dotPositions[i * 3] = (Math.random() - 0.5) * 14;
    dotPositions[i * 3 + 1] = (Math.random() - 0.5) * 10;
    dotPositions[i * 3 + 2] = (Math.random() - 0.5) * 6 - 2;
  }
  dotsGeo.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3));
  const dots = new THREE.Points(dotsGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.018, transparent: true, opacity: 0.25 }));
  scene.add(dots);

  // Mouse parallax
  let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
  document.addEventListener('mousemove', e => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = -(e.clientY / window.innerHeight - 0.5) * 2;
  });

  let raf;
  function animate() {
    raf = requestAnimationFrame(animate);
    const t = performance.now() * 0.001;

    targetX += (mouseX - targetX) * 0.03;
    targetY += (mouseY - targetY) * 0.03;

    torus1.rotation.z = t * 0.07 + targetX * 0.2;
    torus1.rotation.x = Math.PI / 2.2 + targetY * 0.1;
    torus2.rotation.y = t * 0.11;
    torus2.rotation.z = t * -0.06 + targetX * 0.15;
    torus3.rotation.x = t * 0.05;
    torus3.rotation.z = t * -0.04;
    sphere.rotation.y = t * 0.2;
    sphere.rotation.x = t * 0.15;
    dots.rotation.y = t * 0.01 + targetX * 0.05;
    dots.rotation.x = targetY * 0.03;

    renderer.render(scene, camera);
  }

  // Only animate when hero is visible (IntersectionObserver)
  const heroSection = document.getElementById('hero');
  const obs = new IntersectionObserver(entries => {
    entries[0].isIntersecting ? animate() : cancelAnimationFrame(raf);
  });
  obs.observe(heroSection);
})();

// ==========================================
// 3. GSAP SCROLL ANIMATIONS — PREMIUM
// ==========================================
(function initScrollAnimations() {

  // --- HERO PARALLAX: content drifts up as you scroll ---
  gsap.to('.hero-content', {
    scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom top', scrub: true },
    y: 140, opacity: 0.1, ease: 'none'
  });

  // --- SECTION EYEBROWS — letterpress wipe ---
  gsap.utils.toArray('.section-eyebrow').forEach(el => {
    gsap.from(el, {
      scrollTrigger: { trigger: el, start: 'top 90%' },
      opacity: 0, x: -16, duration: 0.6, ease: 'power3.out'
    });
  });

  // --- SECTION TITLES — large beautiful slide-up ---
  gsap.utils.toArray('.section-title').forEach(el => {
    gsap.from(el, {
      scrollTrigger: { trigger: el, start: 'top 87%' },
      y: 70, opacity: 0, skewY: 1.5,
      duration: 1.0, ease: 'power4.out'
    });
  });

  // --- PROOF BAR — stagger numbers and tags ---
  gsap.from('.proof-stat', {
    scrollTrigger: { trigger: '#proof-bar', start: 'top 90%' },
    y: 28, opacity: 0, duration: 0.6,
    stagger: 0.1, ease: 'power3.out'
  });
  gsap.from('.proof-industries span', {
    scrollTrigger: { trigger: '#proof-bar', start: 'top 90%' },
    scale: 0.8, opacity: 0, duration: 0.4,
    stagger: 0.06, ease: 'back.out(1.4)', delay: 0.3
  });

  // --- STAT COUNTER ANIMATION ---
  document.querySelectorAll('.stat-num').forEach(el => {
    const raw = el.textContent.trim();
    const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
    if (isNaN(num) || num === 0) return;
    const prefix = raw.match(/^[^0-9]*/)?.[0] || '';
    const suffix = raw.replace(/^[^0-9]*[\d.,]+/, '');
    el.textContent = prefix + '0' + suffix;
    ScrollTrigger.create({
      trigger: el, start: 'top 85%', once: true,
      onEnter: () => gsap.to({ v: 0 }, {
        v: num, duration: 1.8, ease: 'power2.out',
        onUpdate: function () {
          el.textContent = prefix + Math.round(this.targets()[0].v) + suffix;
        }
      })
    });
  });

  // --- STEP CARDS — 3D cascade with perspective ---
  gsap.from('.step-card', {
    scrollTrigger: { trigger: '#howitworks', start: 'top 74%' },
    y: 70, opacity: 0, rotateX: 10,
    transformOrigin: 'center bottom',
    duration: 0.85, stagger: 0.18, ease: 'power3.out'
  });

  // --- FEATURES — grid wave from top-left ---
  gsap.from('.feature-card', {
    scrollTrigger: { trigger: '#features', start: 'top 78%' },
    y: 44, opacity: 0, duration: 0.55,
    stagger: { each: 0.07, grid: [2, 4], from: 'start' },
    ease: 'power2.out'
  });

  // --- ROI — split horizontal reveal ---
  gsap.from('.roi-left', {
    scrollTrigger: { trigger: '#roi', start: 'top 80%' },
    x: -60, opacity: 0, duration: 1.0, ease: 'power3.out'
  });
  gsap.from('.roi-calculator', {
    scrollTrigger: { trigger: '#roi', start: 'top 80%' },
    x: 60, opacity: 0, duration: 1.0, ease: 'power3.out'
  });

  // --- PRICING — scale pop with spring ---
  gsap.from('.pricing-card', {
    scrollTrigger: { trigger: '#pricing', start: 'top 80%' },
    y: 50, scale: 0.94, opacity: 0,
    duration: 0.75, stagger: 0.13, ease: 'back.out(1.5)'
  });

  // --- TIMELINE — cascade slide from left ---
  gsap.utils.toArray('.timeline-item').forEach((item, i) => {
    gsap.from(item, {
      scrollTrigger: { trigger: item, start: 'top 84%' },
      x: -50, opacity: 0, duration: 0.75,
      delay: i * 0.05, ease: 'power3.out'
    });
  });

  // --- TL STATS — number pop up ---
  gsap.from('.tl-val', {
    scrollTrigger: { trigger: '#results', start: 'top 75%' },
    scale: 0.6, opacity: 0, duration: 0.5,
    stagger: 0.07, ease: 'back.out(2)'
  });

  // --- TESTIMONIALS — fade in stagger ---
  gsap.from('.testimonial-card', {
    scrollTrigger: { trigger: '#testimonials', start: 'top 80%' },
    y: 40, opacity: 0, duration: 0.7,
    stagger: 0.15, ease: 'power3.out'
  });

  // --- CTA — elastic symbol entrance ---
  gsap.from('.cta-symbol', {
    scrollTrigger: { trigger: '#trial', start: 'top 82%' },
    scale: 0.5, opacity: 0, rotation: -30,
    duration: 1.3, ease: 'elastic.out(1, 0.45)'
  });
  gsap.from('.cta-title', {
    scrollTrigger: { trigger: '#trial', start: 'top 80%' },
    y: 50, opacity: 0, duration: 1.0, delay: 0.15, ease: 'power3.out'
  });
  gsap.from('.cta-sub, .btn-xl, .cta-meta', {
    scrollTrigger: { trigger: '#trial', start: 'top 76%' },
    y: 28, opacity: 0, duration: 0.7, stagger: 0.1, delay: 0.25, ease: 'power2.out'
  });

  // --- SCROLL PROGRESS BAR at top ---
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;height:1px;width:0%;background:rgba(255,255,255,0.35);z-index:9999;pointer-events:none;';
  document.body.appendChild(bar);
  gsap.to(bar, {
    scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: 0.2 },
    width: '100%', ease: 'none'
  });

  // --- MOUSE PARALLAX: hero text shifts gently with cursor ---
  document.addEventListener('mousemove', e => {
    const xPct = (e.clientX / window.innerWidth - 0.5);
    const yPct = (e.clientY / window.innerHeight - 0.5);
    gsap.to('.hero-headline', { x: xPct * 18, y: yPct * 10, duration: 1.4, ease: 'power1.out' });
    gsap.to('.hero-sub', { x: xPct * 10, y: yPct * 6, duration: 1.6, ease: 'power1.out' });
    gsap.to('.hero-eyebrow', { x: xPct * 6, y: yPct * 4, duration: 1.8, ease: 'power1.out' });
  });

})();

// ==========================================
// 4. NAV SCROLL BEHAVIOR — ScrollTrigger
// ==========================================
(function initNav() {
  const nav = document.getElementById('navbar');
  ScrollTrigger.create({
    start: 'top -80',
    onUpdate: self => {
      if (self.progress > 0) {
        nav.style.background = 'rgba(0,0,0,0.92)';
        nav.style.boxShadow = '0 1px 0 rgba(255,255,255,0.07)';
      } else {
        nav.style.background = 'rgba(0,0,0,0.7)';
        nav.style.boxShadow = 'none';
      }
    }
  });
})();

// ==========================================
// 5. PRICING CARDS — 3D TILT
// ==========================================
(function initPricingTilt() {
  document.querySelectorAll('.pricing-card').forEach(card => {
    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      card.style.transform = `perspective(800px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg) translateZ(4px)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = 'perspective(800px) rotateY(0) rotateX(0) translateZ(0)';
    });
  });
})();

// ==========================================
// 6. TRIAL FORM HANDLER
// ==========================================
// Trial form removed — CTA now links directly to Cal.com booking

// ==========================================
// 7. ROI CALCULATOR — LIVE COMPUTE
// ==========================================
(function initROI() {
  const ticketInput = document.getElementById('avg-ticket');
  const callsInput = document.getElementById('missed-calls');
  const amountEl = document.getElementById('result-amount');
  const subEl = document.getElementById('result-sub');

  function calc() {
    const ticket = parseFloat(ticketInput?.value) || 0;
    const calls = parseFloat(callsInput?.value) || 0;
    const monthly = Math.round(calls * ticket * 0.35 * 4);
    const formatted = '$' + monthly.toLocaleString();
    if (amountEl) amountEl.textContent = formatted;
    if (subEl) subEl.textContent = `${calls} missed calls × $${ticket} avg × 35% close rate × 4 weeks`;
  }

  ticketInput?.addEventListener('input', calc);
  callsInput?.addEventListener('input', calc);
  calc();
})();

// ─── HAMBURGER MENU ───────────────────────────
(function() {
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('nav-links');
  if (!hamburger || !navLinks) return;

  hamburger.addEventListener('click', function() {
    hamburger.classList.toggle('active');
    navLinks.classList.toggle('open');
  });

  // Close menu on link click
  navLinks.querySelectorAll('a').forEach(function(link) {
    link.addEventListener('click', function() {
      hamburger.classList.remove('active');
      navLinks.classList.remove('open');
    });
  });
})();
