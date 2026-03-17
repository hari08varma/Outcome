import React, { useEffect, useState } from 'react';

export default function OverviewDashboard() {
  const [outcomeCount, setOutcomeCount] = useState(24000);

  useEffect(() => {
    const target = 24847;
    const duration = 1500;
    const step = (target - outcomeCount) / (duration / 16);

    const timer = setInterval(() => {
      setOutcomeCount((prev) => {
        if (prev + step >= target) {
          clearInterval(timer);
          return target;
        }
        return prev + step;
      });
    }, 16);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-[#0A0C10] text-slate-300 font-sans">
      <main className="flex-1 overflow-y-auto relative">
        <header className="flex items-center justify-between px-8 py-6 border-b border-white/5 sticky top-0 bg-[#0A0C10]/95 backdrop-blur-md z-30">
          <div>
            <h1 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Mission Control</h1>
            <p className="text-xl font-bold text-white tracking-tight">DASHBOARD_V5</p>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#00F5A0]/10 border border-[#00F5A0]/20">
              <div className="w-1.5 h-1.5 rounded-full bg-[#00F5A0] animate-pulse"></div>
              <span className="text-[9px] font-bold text-[#00F5A0] uppercase tracking-wider">System Nominal</span>
            </div>
          </div>
        </header>

        <div className="p-8 space-y-8">
          {/* KPI Grid */}
          <div className="grid grid-cols-5 gap-6">
            <div className="bg-[#111318] border border-white/5 rounded-xl p-5">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[9px] uppercase tracking-[0.15em] text-slate-500 font-bold">Total Outcomes</span>
                <span className="text-[#00F5A0] text-[10px] font-mono">+12.5%</span>
              </div>
              <div className="font-mono text-3xl font-bold text-white">
                {Math.floor(outcomeCount).toLocaleString()}
              </div>
            </div>

            <div className="bg-[#111318] border border-white/5 rounded-xl p-5 flex justify-between">
              <div className="space-y-4">
                <span className="text-[9px] uppercase tracking-[0.15em] text-slate-500 font-bold block">Trust Health</span>
                <div className="font-mono text-3xl font-bold text-white">2/3 <span className="text-sm font-normal text-slate-500">Trusted</span></div>
              </div>
              <div className="relative w-12 h-12">
                <svg className="w-full h-full transform -rotate-90">
                  <circle className="text-white/5" cx="24" cy="24" fill="transparent" r="20" strokeWidth="4"></circle>
                  <circle className="text-[#6C63FF]" cx="24" cy="24" fill="transparent" r="20" stroke="currentColor" strokeDasharray="125" strokeDashoffset="42" strokeWidth="4"></circle>
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-[#6C63FF] font-bold">66%</span>
              </div>
            </div>

            <div className="bg-[#FF4D4D]/5 border-2 border-[#FF4D4D] rounded-xl p-5 flex flex-col justify-between cursor-pointer relative shadow-[0_0_20px_rgba(255,77,77,0.1)]">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[9px] uppercase tracking-[0.15em] text-slate-400 font-bold">Silent Failures</span>
              </div>
              <div className="font-mono text-3xl font-bold text-[#FF4D4D]">3</div>
              <div className="mt-2 space-y-1">
                <div className="text-[9px] text-slate-500 font-mono">success=true, score &lt; 0.30</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-8">
            <div className="col-span-8 space-y-8">
              {/* Orbital Visualization Placeholder */}
              <div className="bg-[#111318] border border-white/5 rounded-xl p-8 h-[480px] flex items-center justify-center relative overflow-hidden">
                 <div className="relative z-10 text-center">
                    <p className="text-[10px] uppercase tracking-[0.35em] text-slate-500 font-bold mb-3">Composite Score</p>
                    <div className="text-[100px] font-bold font-mono text-white leading-none tracking-tighter drop-shadow-[0_0_30px_rgba(108,99,255,0.2)]">0.847</div>
                 </div>
              </div>
            </div>

            <div className="col-span-4 space-y-8">
              <div className="bg-[#111318] border border-white/5 border-l-2 border-l-[#6C63FF] rounded-xl p-6 relative overflow-hidden">
                <div className="flex justify-between items-center mb-6 relative z-10">
                  <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">Next Action</span>
                  <span className="font-mono text-[10px] text-[#6C63FF] bg-[#6C63FF]/10 px-2.5 py-1 rounded-md border border-[#6C63FF]/20">0.94 Conf</span>
                </div>
                <h2 className="text-2xl font-bold text-white font-mono mb-4 relative z-10">process_refund</h2>
                <p className="text-sm text-slate-400 leading-relaxed mb-6 relative z-10">
                  System detected a high-confidence refund request. Policy <span className="text-white font-mono">#442</span> requires execution to maintain SLA.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
