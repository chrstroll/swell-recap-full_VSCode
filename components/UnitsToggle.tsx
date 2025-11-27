'use client';
import React from 'react';
import { Units } from '../lib/units';

export default function UnitsToggle({units, onChange}:{units:Units, onChange:(u:Units)=>void}){
  const btn: React.CSSProperties = { padding:'6px 10px', borderRadius:10, border:'1px solid #9ca3af', background:'#f8fafc' };
  return (
    <div style={{ display:'flex', gap:8, alignItems:'center' }}>
      <button type="button" onClick={()=>onChange({...units, temp:units.temp==='F'?'C':'F'})} style={btn}>°{units.temp}</button>
      <button type="button" onClick={()=>onChange({...units, speed:units.speed==='mph'?'kmh':'mph'})} style={btn}>{units.speed}</button>
      <button type="button" onClick={()=>onChange({...units, precip:units.precip==='in'?'mm':'in'})} style={btn}>{units.precip}</button>
    </div>
  );
}
