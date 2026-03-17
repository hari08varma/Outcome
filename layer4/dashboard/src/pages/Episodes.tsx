import React from 'react';

export default function EpisodesDashboard() {
  return (
    <div className="h-full bg-[#0A0C10] text-slate-300 font-sans selection:bg-indigo-500/30 overflow-hidden flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-[#1E232B] bg-[#0A0C10] flex flex-col shrink-0">
        <div className="p-6 flex items-center space-x-3">
          <div className="w-10 h-10 bg-[#6C63FF] rounded-xl flex items-center justify-center shadow-lg shadow-[#6C63FF]/20">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path></svg>
          </div>
          <div>
            <h1 className="font-bold text-white tracking-tight leading-none text-lg">Mission Control</h1>
            <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">Episodes</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full bg-[#0A0C10] overflow-hidden">
        <header className="h-20 flex items-center justify-between px-10 border-b border-[#1E232B]/50">
          <div className="flex items-center space-x-6">
            <nav className="flex items-center text-xs font-medium space-x-3 text-slate-500 uppercase tracking-widest">
              <span>LayerInfinite</span>
              <span className="text-slate-700">/</span>
              <span className="text-white font-bold">Episodes</span>
            </nav>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-10 py-8 space-y-10" style={{scrollbarWidth: 'thin'}}>
          {/* Episodes Feed Table */}
          <section>
            <div className="bg-[#111318] border border-[#1E232B]/50 rounded-2xl overflow-hidden shadow-xl shadow-black/20">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1E232B]/50 bg-white/[0.01]">
                    <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Episode ID</th>
                    <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E232B]/30 text-[13px]">
                  <tr className="hover:bg-white/[0.02] transition-colors group">
                    <td className="px-8 py-5 font-mono text-[#6C63FF] font-bold tracking-tight">550e84...4400</td>
                    <td className="px-8 py-5 text-right flex justify-end">
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-[10px] font-bold bg-[#10B981]/10 text-[#10B981] uppercase tracking-wider">
                        Resolved
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
