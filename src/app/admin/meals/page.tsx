'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useLiveBarcodeScanner, type DetectedBarcode } from '@/lib/qr-scanner';
import { playSuccess, playDuplicate, playError, warmUpAudio } from '@/lib/scanner-audio';
import { supabaseBrowser } from '@/lib/supabase-browser';

type MealResult = {
  success: boolean;
  message: string;
  status: string;
  details?: { visit_date: string; meal_name: string; redeemed_at: string };
};

type SearchResult = {
  id: string;
  meal_uid: string;
  qr_token: string;
  visit_date: string;
  special_title: string;
  booking_ref: string;
  customer_name: string;
  redeemed_at: string | null;
};

const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';

export default function MealScannerPage() {
  const [status, setStatus] = useState<{ tone: 'idle' | 'scanning' | 'success' | 'duplicate' | 'error'; message: string; subtext?: string; details?: any }>({ tone: 'idle', message: 'Ready to scan meals' });
  const [manualQuery, setManualQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [overrideDay, setOverrideDay] = useState(false);
  const processingRef = useRef(false);

  const processToken = useCallback(async (qrToken: string) => {
    if (processingRef.current) return;
    processingRef.current = true;
    setStatus({ tone: 'scanning', message: 'Processing voucher...' });

    try {
      const res = await fetch('/api/admin/meals/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ token: qrToken, override_day: overrideDay })
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
         if (data.status === 'REDEEMED') {
           setStatus({ tone: 'success', message: 'Meal Voucher Valid!', subtext: data.message, details: data.details });
           playSuccess();
         } else if (data.status === 'ALREADY_REDEEMED') {
           setStatus({ tone: 'duplicate', message: 'Already Redeemed', subtext: data.message, details: data.details });
           playDuplicate();
         }
      } else {
         setStatus({ tone: 'error', message: 'Invalid Voucher', subtext: data.error || data.message || 'Error processing voucher' });
         playError();
      }
    } catch (e: any) {
      setStatus({ tone: 'error', message: 'Network Error', subtext: e.message });
      playError();
    } finally {
      setTimeout(() => { processingRef.current = false; }, 1500); // 1.5s cooldown
      
      // Clear manual search if open
      if (manualQuery) {
         setManualQuery('');
         setSearchResults([]);
      }
    }
  }, [overrideDay, manualQuery]);

  const onDetect = useCallback((detected: DetectedBarcode) => {
    processToken(detected.rawValue);
  }, [processToken]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { start, pause } = useLiveBarcodeScanner(videoRef);
  const [permission, setPermission] = useState<string>('granted');

  useEffect(() => {
    start((codes) => {
      if (codes.length > 0) onDetect(codes[0]);
    }).then((track) => {
      if (!track) setPermission('denied');
    });
    return () => pause();
  }, [start, pause, onDetect]);

  const requestPermission = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setPermission('granted');
      start((codes) => {
        if (codes.length > 0) onDetect(codes[0]);
      });
    } catch {
      setPermission('denied');
    }
  };

  useEffect(() => {
    // If URL has a token (scanned via built-in camera app), process it immediately
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      processToken(token);
      // Clean up URL
      window.history.replaceState({}, '', '/admin/meals');
    }
  }, [processToken]);

  const searchMeals = async (e: React.FormEvent) => {
    e.preventDefault();
    if (manualQuery.length < 3) return;
    setIsSearching(true);
    try {
      const res = await fetch(`/api/admin/meals/search?q=${encodeURIComponent(manualQuery)}`, {
         headers: { Authorization: `Bearer ${await token()}` }
      });
      const data = await res.json();
      setSearchResults(data.meals || []);
      if (!res.ok) throw new Error(data.error);
    } catch (e: any) {
       console.error('Search error', e);
    } finally {
       setIsSearching(false);
    }
  };

  const bgColors = {
    idle: 'bg-slate-100 border-slate-300',
    scanning: 'bg-blue-100 border-blue-400',
    success: 'bg-green-100 border-green-500',
    duplicate: 'bg-amber-100 border-amber-500',
    error: 'bg-red-100 border-red-500',
  };
  const textColors = {
    idle: 'text-slate-600',
    scanning: 'text-blue-700',
    success: 'text-green-800',
    duplicate: 'text-amber-800',
    error: 'text-red-800',
  };

  return (
    <div className="flex flex-col h-full bg-black text-white" onPointerDown={warmUpAudio}>
       {/* Scanner Video Area */}
       <div className="relative flex-1 overflow-hidden bg-black flex items-center justify-center">
          {permission === 'granted' ? (
             <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted />
          ) : (
             <div className="p-6 text-center">
                <p className="mb-4 text-slate-300">Camera permission is required to scan QR codes.</p>
                <button onClick={requestPermission} className="px-6 py-3 bg-blue-600 text-white rounded-full font-bold">Allow Camera</button>
             </div>
          )}
          
          {/* Target Overlay */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
             <div className="w-64 h-64 border-2 border-white/50 rounded-2xl relative">
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-green-400 rounded-tl-xl -m-1" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-green-400 rounded-tr-xl -m-1" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-green-400 rounded-bl-xl -m-1" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-green-400 rounded-br-xl -m-1" />
             </div>
          </div>
       </div>

       {/* Status Area */}
       <div className={`p-4 sm:p-6 border-t-4 transition-colors ${bgColors[status.tone]}`}>
          <div className="text-center mb-4">
             <h2 className={`text-2xl font-bold ${textColors[status.tone]}`}>{status.message}</h2>
             {status.subtext && <p className={`mt-1 font-medium ${textColors[status.tone]} opacity-90`}>{status.subtext}</p>}
             {status.details && (
               <div className={`mt-2 text-sm ${textColors[status.tone]} opacity-80`}>
                 <p>{status.details.meal_name}</p>
                 <p>Visit Date: {status.details.visit_date}</p>
                 {status.details.redeemed_at && <p>Redeemed at: {new Date(status.details.redeemed_at).toLocaleTimeString()}</p>}
               </div>
             )}
          </div>

          {/* Manual Search */}
          <form onSubmit={searchMeals} className="flex gap-2">
             <input type="text" value={manualQuery} onChange={e => setManualQuery(e.target.value)} placeholder="Search by booking ref, name or ID..." className="flex-1 p-3 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm" />
             <button type="submit" disabled={isSearching} className="px-6 py-3 bg-slate-800 text-white font-bold rounded-xl shadow-sm active:scale-95">{isSearching ? '...' : 'Search'}</button>
          </form>

          {searchResults.length > 0 && (
             <div className="mt-4 max-h-60 overflow-y-auto bg-white rounded-xl border border-slate-200 divide-y">
                {searchResults.map(m => (
                   <div key={m.id} className="p-3 flex items-center justify-between">
                      <div className="text-slate-800">
                         <div className="font-bold">{m.customer_name} ({m.booking_ref})</div>
                         <div className="text-sm text-slate-500">{m.special_title} - {m.visit_date}</div>
                         <div className="text-xs text-slate-400 font-mono mt-1">{m.meal_uid}</div>
                      </div>
                      <button 
                         onClick={() => processToken(m.qr_token)} 
                         disabled={!!m.redeemed_at}
                         className={`px-4 py-2 rounded-lg font-bold ${m.redeemed_at ? 'bg-slate-100 text-slate-400' : 'bg-green-600 text-white hover:bg-green-700'}`}>
                         {m.redeemed_at ? 'Redeemed' : 'Redeem'}
                      </button>
                   </div>
                ))}
             </div>
          )}

          <div className="mt-4 flex justify-center">
             <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={overrideDay} onChange={e => setOverrideDay(e.target.checked)} className="rounded border-slate-300" />
                Override date restriction (for late redemptions)
             </label>
          </div>
       </div>
    </div>
  );
}
