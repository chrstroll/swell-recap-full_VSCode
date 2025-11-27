export type Units = { temp:'F'|'C', speed:'mph'|'kmh', precip:'in'|'mm' };
export const defaultUnits: Units = { temp:'F', speed:'mph', precip:'in' };
export function toF(c:number){ return (c*9)/5 + 32; }
export function mmToIn(m:number){ return m/25.4; }
export function kmhToMph(k:number){ return k*0.621371; }
export function cardinal(deg:number){
  const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const ix=Math.round(deg/22.5)%16; return dirs[ix];
}
