export default function TrustDashboard() {
  return (
    <div className="flex h-screen bg-[#0A0C10] text-[#E2E8F0] font-sans">
      {/* Sidebar */}
      <aside className="w-64 h-screen sticky top-0 bg-[#07080a] border-r border-white/5 flex flex-col shrink-0">
        <div className="p-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#6C63FF] rounded flex items-center justify-center rotate-45">
              <div className="w-3 h-3 bg-white -rotate-45"></div>
            </div>
            <span className="font-bold text-lg tracking-tight uppercase">LayerInfinite</span>
          </div>
        </div>
        <nav className="flex-1 px-3 space-y-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          <div className="text-[10px] text-[#94A3B8] font-bold uppercase tracking-widest px-3 mb-4 mt-6">Core Operations</div>
          <a className="flex items-center gap-3 px-3 py-2.5 text-[#94A3B8] hover:text-white hover:bg-white/5 rounded transition-all text-sm" href="#">
            <span className="material-symbols-outlined text-xl">dashboard</span> Dashboard
          </a>
          <a className="flex items-center gap-3 px-3 py-2.5 text-[#94A3B8] hover:text-white hover:bg-white/5 rounded transition-all text-sm" href="#">
            <span className="material-symbols-outlined text-xl">smart_toy</span> Agents
          </a>
          <a className="flex items-center gap-3 px-3 py-2.5 bg-[#6C63FF]/10 text-[#6C63FF] border-r-2 border-[#6C63FF] text-sm font-semibold" href="#">
            <span className="material-symbols-outlined text-xl">verified_user</span> Trust Integrity
          </a>
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        <header className="h-20 border-b border-white/5 flex items-center justify-between px-10 bg-[#07080a]/50 backdrop-blur-md sticky top-0 z-50">
          <div className="flex items-baseline gap-4">
            <h1 className="text-2xl font-black tracking-tight uppercase">Agent Trust</h1>
            <span className="px-2 py-0.5 bg-[#6C63FF]/10 border border-[#6C63FF]/20 text-[#6C63FF] text-[9px] font-bold rounded uppercase tracking-widest">
              Mission Control V5
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#111318] border border-white/5 rounded text-[10px] font-mono text-[#94A3B8] uppercase">
              <span className="w-2 h-2 rounded-full bg-[#22C55E] animate-pulse"></span> System Normal
            </div>
          </div>
        </header>

        <main className="p-10 space-y-6 max-w-6xl mx-auto">
          {/* Agent 1 */}
          <section className="bg-[#111318] rounded-xl p-8 relative overflow-hidden group shadow-[0_0_20px_rgba(34,197,94,0.1)] border border-[#22C55E]/20">
            <div className="flex justify-between items-start">
              <div className="flex gap-6">
                <div className="w-14 h-14 bg-[#22C55E]/10 border border-[#22C55E]/20 rounded-lg flex items-center justify-center">
                  <span className="material-symbols-outlined text-3xl text-[#22C55E]">security</span>
                </div>
                <div>
                  <h2 className="text-2xl font-bold tracking-tight mb-1">payment-bot-1</h2>
                  <div className="flex items-center gap-3">
                    <p className="text-[10px] text-[#94A3B8] font-mono uppercase tracking-widest">Transactional</p>
                    <span className="w-1 h-1 rounded-full bg-white/10"></span>
                    <p className="text-[10px] text-[#94A3B8] font-mono uppercase tracking-widest">2m ago</p>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 bg-[#22C55E]/10 text-[#22C55E] text-[9px] font-bold tracking-widest uppercase rounded border border-[#22C55E]/20">Trusted</span>
                <div className="text-4xl font-mono mt-2 text-white">0.923</div>
              </div>
            </div>
          </section>

          {/* Agent 2 */}
          <section className="bg-[#111318] rounded-xl p-8 relative overflow-hidden group shadow-[0_0_20px_rgba(245,158,11,0.1)] border border-[#245,158,11]/20">
            <div className="flex justify-between items-start">
              <div className="flex gap-6">
                <div className="w-14 h-14 bg-[#F59E0B]/10 border border-[#F59E0B]/20 rounded-lg flex items-center justify-center">
                  <span className="material-symbols-outlined text-3xl text-[#F59E0B]">warning</span>
                </div>
                <div>
                  <h2 className="text-2xl font-bold tracking-tight mb-1">refund-agent-v2</h2>
                  <div className="flex items-center gap-3">
                    <p className="text-[10px] text-[#94A3B8] font-mono uppercase tracking-widest">Customer_Ops</p>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 bg-[#F59E0B]/10 text-[#F59E0B] text-[9px] font-bold tracking-widest uppercase rounded border border-[#F59E0B]/20">Probation</span>
                <div className="text-4xl font-mono mt-2 text-white">0.541</div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
