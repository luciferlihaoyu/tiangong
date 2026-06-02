import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  z: number;
  size: number;
  opacity: number;
  speed: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

export default function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const starsRef = useRef<Star[]>([]);
  const themeRef = useRef<'dark' | 'light'>('dark');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Watch theme changes
    const observer = new MutationObserver(() => {
      themeRef.current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Init stars
    const count = 300;
    starsRef.current = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      z: Math.random(),
      size: 0.3 + Math.random() * 1.5,
      opacity: 0.1 + Math.random() * 0.8,
      speed: 0.02 + Math.random() * 0.08,
      twinkleSpeed: 0.5 + Math.random() * 2,
      twinkleOffset: Math.random() * Math.PI * 2,
    }));

    let time = 0;

    function animate() {
      if (!canvas || !ctx) return;
      time += 0.016;
      const isLight = themeRef.current === 'light';

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const star of starsRef.current) {
        // Twinkle
        const twinkle = Math.sin(time * star.twinkleSpeed + star.twinkleOffset) * 0.3 + 0.7;
        const alpha = star.opacity * twinkle * (isLight ? 0.3 : 1);

        // Parallax drift
        star.x += star.speed * (isLight ? 0.2 : 1);
        if (star.x > canvas.width) star.x = 0;

        // Color: gold-tinted stars
        const r = isLight ? 100 : 220 + star.z * 35;
        const g = isLight ? 110 : 215 + star.z * 40;
        const b = isLight ? 140 : 235 + star.z * 20;

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size * (0.5 + star.z * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
        ctx.fill();

        // Glow for bright stars
        if (star.opacity > 0.6 && star.z > 0.5) {
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha * 0.08})`;
          ctx.fill();
        }
      }

      // Draw constellation lines (subtle)
      if (!isLight) {
        ctx.strokeStyle = 'rgba(180, 200, 255, 0.015)';
        ctx.lineWidth = 0.5;
        const stars = starsRef.current;
        for (let i = 0; i < stars.length; i += 7) {
          for (let j = i + 1; j < stars.length; j += 11) {
            const dx = stars[i].x - stars[j].x;
            const dy = stars[i].y - stars[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 120) {
              ctx.beginPath();
              ctx.moveTo(stars[i].x, stars[i].y);
              ctx.lineTo(stars[j].x, stars[j].y);
              ctx.stroke();
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(animate);
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
