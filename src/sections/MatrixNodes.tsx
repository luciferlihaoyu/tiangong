import { useRef, useEffect, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

function canCreateWebGLContext() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return !!gl;
  } catch {
    return false;
  }
}

function Scene() {
  const groupRef = useRef<THREE.Group>(null);
  const instancedMeshRef = useRef<THREE.InstancedMesh>(null);
  const positionsRef = useRef<THREE.Vector3[]>([]);

  useEffect(() => {
    if (!instancedMeshRef.current) return;
    const dummy = new THREE.Object3D();
    const sphere: THREE.Vector3[] = [];
    for (let i = 0; i < 140; i++) {
      const radius = 9 + Math.random() * 23;
      const angle = Math.random() * Math.PI * 2;
      const yPos = -6 + Math.random() * 12;
      const x = Math.cos(angle) * radius;
      const y = yPos;
      const z = Math.sin(angle) * radius;
      dummy.position.set(x, y, z);
      const scale = 0.05 + Math.random() * 0.1;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      instancedMeshRef.current.setMatrixAt(i, dummy.matrix);
      sphere.push(new THREE.Vector3(x, y, z));
    }
    instancedMeshRef.current.instanceMatrix.needsUpdate = true;
    positionsRef.current = sphere;
  }, []);

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = state.clock.getElapsedTime() * 0.03;
    state.camera.lookAt(0, 0, 0);
    groupRef.current.rotation.x = state.mouse.y * 0.1;
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={instancedMeshRef} args={[null as any, null as any, 140]}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial color="#c9a84c" transparent opacity={0.12} />
      </instancedMesh>
      <Connections positions={positionsRef.current} />
    </group>
  );
}

function Connections({ positions }: { positions: THREE.Vector3[] }) {
  const maxDistance = 4.5;
  const linesRef = useRef<{ start: THREE.Vector3; end: THREE.Vector3 }[]>([]);
  const lineGeo = useRef<THREE.BufferGeometry>(new THREE.BufferGeometry());

  useEffect(() => {
    if (!positions || positions.length === 0) return;
    const newLines: typeof linesRef.current = [];
    for (let i = 0; i < positions.length; i++) {
      const p1 = positions[i];
      if (!p1) continue;
      for (let j = i + 1; j < positions.length; j++) {
        const p2 = positions[j];
        if (!p2) continue;
        if (p1.distanceTo(p2) < maxDistance) newLines.push({ start: p1, end: p2 });
      }
    }
    linesRef.current = newLines;
    const arr: number[] = [];
    for (const line of newLines) {
      arr.push(line.start.x, line.start.y, line.start.z);
      arr.push(line.end.x, line.end.y, line.end.z);
    }
    lineGeo.current.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  }, [positions]);

  return (
    <lineSegments ref={lineGeo}>
      <lineBasicMaterial color="#c9a84c" transparent opacity={0.06} />
    </lineSegments>
  );
}

export default function MatrixNodes() {
  const [webglAvailable, setWebglAvailable] = useState(true);

  useEffect(() => {
    setWebglAvailable(canCreateWebGLContext());
  }, []);

  return (
    <section className="relative z-10 w-full py-4 px-4 md:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="glass-panel p-4 overflow-hidden sci-border">
          <div className="flex items-center justify-between mb-3">
            <div className="section-label">ARCHITECTURE VISUALIZATION · 架构可视化</div>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{webglAvailable ? '140 nodes · 实时渲染' : 'static mode · WebGL 降级'}</span>
          </div>
          <div className="w-full h-[280px] rounded overflow-hidden relative" style={{ background: 'rgba(0,0,0,0.3)' }}>
            {webglAvailable ? (
              <Canvas
                camera={{ position: [0, 0, 30], fov: 50 }}
                gl={{ antialias: true, alpha: true }}
                onCreated={({ gl }) => {
                  gl.domElement.addEventListener('webglcontextlost', () => setWebglAvailable(false), { once: true });
                }}
                onError={() => setWebglAvailable(false)}>
                <Scene />
              </Canvas>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
                <div className="absolute inset-0 opacity-30" style={{
                  backgroundImage: 'radial-gradient(circle at 30% 35%, rgba(201,168,76,0.22), transparent 18%), radial-gradient(circle at 62% 48%, rgba(194,58,48,0.18), transparent 20%), radial-gradient(circle at 76% 28%, rgba(86,190,216,0.12), transparent 16%), linear-gradient(135deg, rgba(201,168,76,0.08) 0 1px, transparent 1px 24px)',
                }} />
                <div className="relative z-10 text-center font-mono">
                  <div className="text-sm font-bold tracking-widest" style={{ color: 'var(--accent-gold)' }}>TIANGONG AGENT MESH</div>
                  <div className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>WebGL unavailable · static architecture view</div>
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            {[
              { title: '统一消息网关', desc: 'Slack、邮件、Webhook 消息流自动汇集' },
              { title: '任务智能分派', desc: 'Agent 自动认领，支持优先级与负载均衡' },
              { title: '全链路审计', desc: '思考过程与工具调用全记录，透明可控' },
            ].map((f) => (
              <div key={f.title} className="flex items-start gap-2 p-2 rounded hover:bg-[rgba(180,200,255,0.02)] transition-colors">
                <span className="w-1 h-1 rounded-full mt-1.5 flex-shrink-0" style={{ background: 'var(--accent-red)' }} />
                <div>
                  <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{f.title}</div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
