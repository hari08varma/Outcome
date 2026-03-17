import React from 'react';

export default function AlertsDashboard() {
  return (
    <div className="flex h-screen overflow-hidden bg-[#0A0C10] text-[#E2E8F0] font-sans">
      <main className="flex-1 flex flex-col min-w-0 bg-[#0A0C10] overflow-y-auto">
        <header className="h-16 border-b border-[#1E232D] flex items-center justify-between px-8 sticky top-0 bg-[#0A0C10]/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Mission Control</span>
            <span className="text-slate-700">/</span>
            <span className="text-slate-200 font-medium">Alerts</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center px-3 py-1 bg-[#EF4444]/10 border border-[#EF4444]/20 rounded-full">
              <span className="w-2 h-2 rounded-full bg-[#EF4444] mr-2 animate-pulse"></span>
              <span className="text-[#EF4444] text-xs font-bold uppercase tracking-wider">3 Active</span>
            </div>
          </div>
        </header>

        <section className="px-8 py-4 border-b border-[#1E232D] flex flex-wrap items-center justify-between gap-4 bg-slate-900/10">
          <div className="flex items-center gap-3">
            <select className="bg-[#0D0F14] border-[#1E232D] text-xs rounded-md focus:ring-[#6C63FF] focus:border-[#6C63FF] text-slate-300">
              <option>All Types</option>
            </select>
          </div>
        </section>
        
        <div className="p-8 space-y-4">
            <div className="bg-[#0D0F14] border border-[#EF4444]/30 rounded-xl p-5 hover:border-[#EF4444]/50 transition-colors relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-[#EF4444]"></div>
              <div className="flex gap-5">
                <div className="w-10 h-10 rounded-lg bg-[#EF4444]/10 text-[#EF4444] flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                </div>
                <div className="flex-1">
                  <div className="flex items-start justify-between mb-1">
                    <h3 className="text-sm font-semibold text-white">Critical Alert: Hallucination Detected</h3>
                    <span className="text-xs text-slate-500 font-mono">2m ago</span>
                  </div>
                  <p className="text-sm text-slate-400 leading-relaxed mb-4">Agent `payment-bot-1` self-reported success=true but verifier downstream returned failure.</p>
                </div>
              </div>
            </div>
        </div>

      </main>
    </div>
  );
}
