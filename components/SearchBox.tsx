'use client';
import React, { useEffect, useState } from 'react';

type Suggestion = {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
};

export default function SearchBox({
  query,
  setQuery,
  onPick,
  groupRight = false,
  onEnter,
  onType,
}: {
  query: string;
  setQuery: (s: string) => void;
  onPick: (s: Suggestion) => void;
  groupRight?: boolean;
  onEnter?: () => void;
  onType?: () => void;
}) {
  // local state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);

  // fetch suggestions (debounced)
  useEffect(() => {
    const id: ReturnType<typeof setTimeout> = setTimeout(async () => {
      const q = query.trim();
      if (!q) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      try {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
          q
        )}&count=5&language=en&format=json`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        const list: Suggestion[] = (data.results || []).map((r: any) => ({
          name: r.name,
          latitude: r.latitude,
          longitude: r.longitude,
          admin1: r.admin1,
          country: r.country,
        }));
        setSuggestions(list);
        setOpen(list.length > 0);
      } catch {
        // ignore network errors for suggestions
      }
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onType?.(); // notify parent user is typing
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.(); // trigger parent search
          }
        }}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onBlur={() => {
          // close after click events on items fire
          setTimeout(() => setOpen(false), 120);
        }}
        placeholder="Search city or address"
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1px solid #ccc',
          borderRight: groupRight ? '0' : '1px solid #ccc',
          borderRadius: groupRight ? '10px 0 0 10px' : '10px',
        }}
      />
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '42px',
            left: 0,
            right: 0,
            background: '#fff',
            border: '1px solid #e5e7eb',
            boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
            borderRadius: 12,
            zIndex: 10,
            overflow: 'hidden',
          }}
        >
          {suggestions.map((s, i) => (
            <div
              key={`${s.latitude},${s.longitude},${i}`}
              onMouseDown={() => {
                onPick(s); // let parent set selected + label
                setOpen(false);
              }}
              style={{ padding: '10px 12px', cursor: 'pointer' }}
            >
              {s.name}
              {s.admin1 ? `, ${s.admin1}` : ''}
              {s.country ? `, ${s.country}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
