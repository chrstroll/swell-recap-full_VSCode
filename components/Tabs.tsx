'use client';
import React from 'react';
export default function Tabs({tab, setTab}:{tab:string, setTab:(t:string)=>void}){
  const Item=({id,label}:{id:string,label:string})=>(
    <button onClick={()=>setTab(id)} style={{
      padding:'10px 14px', borderRadius:12, border:'1px solid #e2e8f0',
      background: tab===id?'#e6f0f6':'#fff', fontWeight: tab===id?700:500
    }}>{label}</button>
  );
  return <div style={{display:'flex', gap:8}}><Item id="overview" label="Overview"/><Item id="accuracy" label="Accuracy"/></div>;
}
