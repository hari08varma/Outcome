import React from 'react';

export default function ActionScoresDashboard() {
  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[#0A0C10] text-[#f8fafc] font-sans">
      <header className="border-b border-white/5 bg-[#0A0C10]/80 backdrop-blur-md h-16 flex items-center justify-between px-6 shrink-0 z-50">
        <div className="flex items-center gap-8">
          <div className="font-bold tracking-tight text-lg font-mono uppercase">LayerInfinite</div>
        </div>
      </header>
      
      <main className="flex-1 flex overflow-hidden">
        <section className="flex-1 flex flex-col p-8 overflow-y-auto border-r border-white/5">
          <div className="flex justify-between items-start mb-10">
            <div>
              <h1 className="text-4xl font-bold font-mono tracking-tighter mb-2">Mission Control</h1>
              <p className="text-slate-500 text-xs font-mono uppercase tracking-widest">Action Scores Deep Dive</p>
            </div>
          </div>
          
          <div className="bg-[#111318] rounded-xl border border-white/5 overflow-hidden shadow-2xl">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white/[0.02] text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold font-mono">
                  <th className="px-8 py-5 border-b border-white/5">Action Handle</th>
                  <th className="px-8 py-5 border-b border-white/5">Success Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-sm font-mono">
                <tr className="hover:bg-white/[0.02] transition-colors bg-[#6C63FF]/[0.03]">
                  <td className="px-8 py-6">
                    <div className="font-bold text-white mb-1">process_refund</div>
                    <div className="text-[9px] text-slate-500 uppercase tracking-widest">v2.4.1</div>
                  </td>
                  <td className="px-8 py-6">
                    <div className="text-[#10b981] font-bold text-xl">98.2%</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
