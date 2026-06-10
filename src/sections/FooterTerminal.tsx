import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const LOG_MESSAGES = [
  'SYSTEM ACTIVE', 'NODE CONNECTED', 'TIANGONG_V2.1', '403ms', 'SYNC_OK',
  'AGENT_POOL_READY', 'HEARTBEAT_NOMINAL', 'COST_TRACKING_ON', 'GOVT_AUDIT_PASS', 'TASK_QUEUE_BALANCED',
];

export default function FooterTerminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050508);
    scene.fog = new THREE.Fog(0x050508, 10, 60);

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.y = 8;
    camera.position.z = 5;
    camera.rotation.x = -Math.PI / 2.5;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(container.clientWidth, container.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    } catch (error) {
      console.warn('FooterTerminal WebGL unavailable, falling back to static footer.', error);
      canvas.style.display = 'none';
      return;
    }

    const gridHelper = new THREE.GridHelper(80, 40, 0xc9a84c, 0x0a0a12);
    gridHelper.position.y = -2;
    scene.add(gridHelper);

    const textGroup = new THREE.Group();
    scene.add(textGroup);

    const textCanvas = document.createElement('canvas');
    textCanvas.width = 512;
    textCanvas.height = 128;
    const textCtx = textCanvas.getContext('2d')!;

    const floatingTexts: { mesh: THREE.Mesh; speed: number; life: number }[] = [];

    function addFloatingText(content: string) {
      textCtx.clearRect(0, 0, 512, 128);
      textCtx.fillStyle = 'rgba(201, 168, 76, 0.9)';
      textCtx.font = 'bold 36px "Courier New", monospace';
      textCtx.textAlign = 'center';
      textCtx.textBaseline = 'middle';
      textCtx.fillText(content, 256, 64);
      const texture = new THREE.CanvasTexture(textCanvas);
      texture.needsUpdate = true;
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.3 });
      const geometry = new THREE.PlaneGeometry(4, 1);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.x = (Math.random() - 0.5) * 30;
      mesh.position.z = -Math.random() * 40 - 5;
      mesh.position.y = -1 + Math.random() * 3;
      mesh.rotation.x = -0.2;
      textGroup.add(mesh);
      floatingTexts.push({ mesh, speed: 0.01 + Math.random() * 0.02, life: 1.0 });
    }

    const particleCount = 150;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      particlePositions[i * 3] = (Math.random() - 0.5) * 60;
      particlePositions[i * 3 + 1] = Math.random() * 10 - 2;
      particlePositions[i * 3 + 2] = -Math.random() * 60;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    const particleMat = new THREE.PointsMaterial({ color: 0xc9a84c, size: 0.05, transparent: true, opacity: 0.3 });
    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    let prevScrollY = 0;
    let frameCount = 0;

    function animate() {
      frameCount++;
      const scrollProgress = window.scrollY / (document.body.scrollHeight - window.innerHeight);
      const targetScrollY = scrollProgress * 1000;
      prevScrollY += (targetScrollY - prevScrollY) * 0.1;
      camera.position.z = 5 + prevScrollY * 0.02;

      if (frameCount % 60 === 0 && Math.random() < 0.3) {
        addFloatingText(LOG_MESSAGES[Math.floor(Math.random() * LOG_MESSAGES.length)]);
      }

      for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.mesh.position.y += ft.speed;
        ft.life -= 0.002;
        (ft.mesh.material as THREE.MeshBasicMaterial).opacity = ft.life * 0.3;
        if (ft.life <= 0) {
          textGroup.remove(ft.mesh);
          ft.mesh.geometry.dispose();
          (ft.mesh.material as THREE.MeshBasicMaterial).dispose();
          floatingTexts.splice(i, 1);
        }
      }

      const positions = particles.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < particleCount; i++) {
        positions[i * 3 + 1] += 0.005;
        if (positions[i * 3 + 1] > 8) positions[i * 3 + 1] = -2;
      }
      particles.geometry.attributes.position.needsUpdate = true;
      gridHelper.position.z = (prevScrollY * 0.01) % 2;

      renderer.render(scene, camera);
      rafRef.current = requestAnimationFrame(animate);
    }

    rafRef.current = requestAnimationFrame(animate);

    function handleResize() {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    }
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
    };
  }, []);

  return (
    <section className="relative z-10 w-full overflow-hidden" style={{ height: '60vh', minHeight: '400px' }}>
      <div ref={containerRef} className="absolute inset-0">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
        <div className="text-center px-6">
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="section-label">GET STARTED</div>
            <div className="h-3 w-px" style={{ background: 'var(--border-default)' }} />
            <div className="text-[10px] font-mono" style={{ color: 'var(--accent-red)' }}>开始部署</div>
          </div>
          <h2 className="text-2xl md:text-3xl font-black tracking-wider mb-3" style={{ color: 'var(--text-primary)' }}>
            开启你的智能中枢
          </h2>
          <p className="text-xs max-w-md mx-auto mb-6 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            一行命令，部署你的 AI Agent 团队。开源、自托管、交互式安装引导。
          </p>
          <div className="terminal-panel p-4 max-w-sm mx-auto mb-6">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--accent-red)', opacity: 0.6 }} />
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--accent-gold)', opacity: 0.4 }} />
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--accent-cyan)', opacity: 0.3 }} />
              <span className="text-[10px] ml-1 font-mono" style={{ color: 'var(--text-muted)' }}>bash</span>
            </div>
            <code className="font-mono text-xs block text-left" style={{ color: 'var(--accent-gold)' }}>
              $ npx tiangong onboard --yes
            </code>
          </div>
          <div className="flex items-center justify-center gap-3">
            <button className="px-5 py-2 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110"
              style={{ background: 'var(--accent-red)', color: '#fff', boxShadow: '0 0 16px rgba(194, 58, 48, 0.25)' }}>
              立即开始
            </button>
            <button className="px-5 py-2 rounded text-xs font-mono transition-all hover:bg-[rgba(180,200,255,0.04)]"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
              阅读文档
            </button>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 px-6 py-4">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <div className="flex items-center gap-4">
              <span> 2026 天宫 Tiangong</span>
              <span>MIT License</span>
              <span>开源</span>
            </div>
            <div className="flex items-center gap-4">
              {['GitHub', '文档', 'Discord', 'Twitter'].map((l) => (
                <a key={l} href="#" className="hover:text-[var(--accent-red)] transition-colors">{l}</a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
