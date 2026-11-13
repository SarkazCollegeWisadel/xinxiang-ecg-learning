import {memo,useMemo} from 'react';
import {colors,leads,norm,leadCoefficients,qrsName,type Frame,type Vec,type Controls} from './engine';
import type {Case} from './cases';
import type {LeadId} from './vendor/types';
export function Projection({frames,frame,baseline,plane,compare,clinical,controls,selected,isReal}:{frames:Frame[];frame:Frame;baseline:Frame[];plane:'frontal'|'horizontal'|'sagittal';compare:boolean;clinical:Case;controls:Controls;selected:LeadId;isReal:boolean}){
 const config={frontal:{title:'额面',en:'FRONTAL',h:'x',v:'y',right:'左 +X',bottom:'下 +Y',top:'上',left:'右'},horizontal:{title:'水平面',en:'TRANSVERSE',h:'x',v:'z',right:'左 +X',bottom:'后 +Z',top:'前',left:'右'},sagittal:{title:'矢状面',en:'SAGITTAL',h:'z',v:'y',right:'后 +Z',bottom:'下 +Y',top:'上',left:'前'}}[plane];
 const extent=useMemo(()=>Math.max(.8,...frames.map(f=>norm(f.vector)),...baseline.map(f=>norm(f.vector)))*1.18,[frames,baseline]);
 const project=(v:Vec)=>[150+v[config.h as keyof Vec]/extent*107,114+v[config.v as keyof Vec]/extent*87];
 const paths=useMemo(()=>Object.keys(colors).map(phase=>({phase,d:frames.filter((_,i)=>i%3===0).reduce((s,f,i,a)=>{const [x,y]=project(f.vector);return s+(f.phase===phase?`${i&&a[i-1].phase===phase?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`:'');},'')})),[frames,extent,plane]);
 const normal=useMemo(()=>baseline.filter((_,i)=>i%3===0).map((f,i)=>`${i?'L':'M'}${project(f.vector).join(',')}`).join(' '),[baseline,extent,plane]);
 const directionMarks=useMemo(()=>['P','QRS','T'].flatMap(phase=>{const start=frames.findIndex(f=>f.phase===phase&&norm(f.vector)>.02);if(start<0)return [];let end=start;while(end+1<frames.length&&frames[end+1].phase===phase)end++;const mid=Math.min(end,Math.floor(start+(end-start)*.55));const a=project(frames[mid].vector),b=project(frames[Math.min(mid+2,end)].vector);return [{phase,start:project(frames[start].vector),end:project(frames[end].vector),mid:a,angle:Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI}];}),[frames,extent,plane]);
 const [x,y]=project(frame.vector);const leadAngles=plane==='frontal'?[0,60,120,-150,-30,90]:[];
 const chestAxes=useMemo(()=>plane==='horizontal'&&!isReal?leads.slice(6).map(l=>{const v=leadCoefficients(clinical,controls,l);const length=Math.hypot(v.x,v.z)||1;return {lead:l,x:v.x/length,z:v.z/length};}):[],[plane,clinical,controls,isReal]);
 const selectedAxis=chestAxes.find(a=>a.lead===selected),scalar=selectedAxis?frame.vector.x*selectedAxis.x+frame.vector.z*selectedAxis.z:0;
 const foot=selectedAxis?project({x:scalar*selectedAxis.x,y:0,z:scalar*selectedAxis.z}):null;
 return <section className="panel projection"><div className="panel-heading"><h3>{config.title}<span>{config.en}</span></h3><small>{plane==='frontal'?'Einthoven · 六轴':plane==='horizontal'?'V1–V6 的空间关系':'前后 · 上下'}</small></div>
 <svg viewBox="0 0 300 237" role="img" aria-label={config.title+'向量环投影'}>
  <defs><marker id={'tip-'+plane} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={colors[frame.phase]}/></marker></defs>
  {[35,70,105].map(r=><ellipse key={r} cx="150" cy="114" rx={r} ry={r*.81} fill="none" stroke="#e6eaee" strokeDasharray="2 4"/>)}
  <path d="M30 114H270M150 18V210" stroke="#ccd3db"/>
  {leadAngles.map((a,i)=>{const r=a*Math.PI/180;return <g key={a}><path d={`M${150-Math.cos(r)*96},${114-Math.sin(r)*78} L${150+Math.cos(r)*96},${114+Math.sin(r)*78}`} stroke="#d5dce2" strokeDasharray="3 4"/><text x={150+Math.cos(r)*117} y={117+Math.sin(r)*94} textAnchor="middle" fill="#97a3ae" fontSize="9">{leads[i]}</text></g>;})}
  {chestAxes.map(a=><g key={a.lead}><path d={`M150 114L${150+a.x*95} ${114+a.z*77}`} stroke={a.lead===selected?'#a78bc6':'#cbdcd6'} strokeWidth={a.lead===selected?1.3:.7} strokeDasharray="3 3"/><text x={150+a.x*111} y={117+a.z*91} textAnchor="middle" style={{fill:a.lead===selected?'#8c6cb2':'#89a79b',fontSize:8}}>{a.lead}</text></g>)}
  {foot&&<><path d={`M${x} ${y}L${foot.join(' ')}`} stroke="#a591bd" strokeDasharray="2 3"/><path d={`M150 114L${foot.join(' ')}`} stroke="#ab95c3" strokeWidth="3" opacity=".6"/></>}
  {compare&&<path d={normal} fill="none" stroke="#b9c1c9" strokeWidth="1.4" strokeDasharray="3 3" opacity=".8"/>}
  {paths.map(p=><path key={p.phase} d={p.d} fill="none" stroke={colors[p.phase]} strokeWidth="1.8" strokeLinecap="round"/>)}
  {directionMarks.map(m=><g key={m.phase} fill={colors[m.phase]}><circle cx={m.start[0]} cy={m.start[1]} r="2.2" fill="white" stroke={colors[m.phase]}/><circle cx={m.end[0]} cy={m.end[1]} r="1.8"/><path d="M-3 -2.5L3 0L-3 2.5Z" transform={`translate(${m.mid.join(' ')}) rotate(${m.angle})`}/></g>)}
  <path d={`M150 114L${x} ${y}`} stroke={colors[frame.phase]} strokeWidth="2.5" markerEnd={`url(#tip-${plane})`}/><circle cx={x} cy={y} r="3.5" fill={colors[frame.phase]} stroke="white" strokeWidth="1.5"/>
  <circle cx="150" cy="114" r="2" fill="#929da7"/>
  <text x="285" y="130" textAnchor="end">{config.right}</text><text x="153" y="229">{config.bottom}</text><text x="153" y="13">{config.top}</text><text x="10" y="130">{config.left}</text>
 </svg><div className="projection-note">{plane==='horizontal'&&!isReal?'虚线：导联场的水平分量 · 非完整胸前电压':'○ 起点 · ● 终点 · 小箭头为时间方向'}</div></section>;
}
export function DetailWave({frames,index,lead,onSeek,isReal}:{frames:Frame[];index:number;lead:LeadId;onSeek:(i:number)=>void;isReal:boolean}){
 const f=frames[index],duration=frames.at(-1)!.t,start=Math.max(0,Math.min(duration-1.2,f.t-.48)),end=start+1.2;
 const window=frames.filter(p=>p.t>=start&&p.t<=end),gain=Math.max(.8,...window.map(p=>Math.abs(p.leads[lead])))*1.15;
 const px=(t:number)=>45+(t-start)/1.2*1050,py=(v:number)=>95-v/gain*64;
 const d=window.map((p,i)=>`${i?'L':'M'}${px(p.t).toFixed(2)},${py(p.leads[lead]).toFixed(2)}`).join('');
 const segments:{phase:string;a:number;b:number}[]=[];for(const p of window){const last=segments.at(-1);if(last?.phase===p.phase)last.b=p.t;else segments.push({phase:p.phase,a:p.t,b:p.t});}
 const names=!isReal&&start<.4&&end>.57?qrsName(frames,lead):null;
 return <section className="panel detail-wave"><div className="panel-heading"><h3>{lead} · 局部波形放大 <span>{start.toFixed(2)}–{end.toFixed(2)} s</span></h3><small>{names?`首搏 QRS：${names}`:isReal?'原始波形 · 未自动分期':'随时间轴平移的 1.2 秒窗口'}</small></div><svg viewBox="0 0 1140 190" aria-label="当前导联局部放大图" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();const t=start+((e.clientX-r.left)/r.width*1140-45)/1050*1.2;onSeek(Math.max(0,Math.min(frames.length-1,Math.round(t/duration*(frames.length-1)))));}}>
 <defs><pattern id="detail-grid" width={35} height={64/gain*.1} patternUnits="userSpaceOnUse"><path d={`M35 0H0V${64/gain*.1}`} fill="none" stroke="#ecdfe4" strokeWidth=".7"/></pattern></defs><rect x="45" y="20" width="1050" height="146" fill="#fffbfc"/><rect x="45" y="20" width="1050" height="146" fill="url(#detail-grid)"/>
 {!isReal&&segments.filter(s=>s.phase!=='静息').map((s,i)=><g key={i}><rect x={px(s.a)} y="20" width={Math.max(1,px(s.b)-px(s.a))} height="146" fill={colors[s.phase]} opacity=".055"/><text x={(px(s.a)+px(s.b))/2} y="15" textAnchor="middle" style={{fill:colors[s.phase],fontSize:9}}>{s.phase}</text></g>)}
 <path d={`M45 95H1095`} stroke="#d4c7cd" strokeWidth=".6"/><path d={d} fill="none" stroke="#467c6c" strokeWidth="1.7"/><path d={`M${px(f.t)} 20V166`} stroke="#9b81bd" strokeWidth="1"/><circle cx={px(f.t)} cy={py(f.leads[lead])} r="3" fill="#8d70b3"/>
 {[0,.2,.4,.6,.8,1,1.2].map(k=><text key={k} x={px(start+k)} y="183" textAnchor="middle" style={{fontSize:9,fill:'#a6a5ad'}}>{(start+k).toFixed(2)} s</text>)}{[-1,0,1].map(k=><text key={k} x="38" y={py(gain*k)+3} textAnchor="end" style={{fontSize:8,fill:'#a6a5ad'}}>{(gain*k).toFixed(1)}</text>)}
 </svg><p>命名按所选导联的偏转顺序：首个负向为 Q，正向为 R，R 后负向为 S；全负为 QS。大小写按振幅区分，深浅本身不能判定病理性。</p></section>;
}
export const Wave=memo(function Wave({frames,baseline,lead,index,selected,compare,onSeek,onSelect}:{frames:Frame[];baseline:Frame[];lead:LeadId;index:number;selected:boolean;compare:boolean;onSeek:(i:number)=>void;onSelect:(l:LeadId)=>void}){
 const W=520,H=125,duration=frames.at(-1)?.t||6,range=useMemo(()=>Math.max(1.8,...frames.map(f=>Math.abs(f.leads[lead])),...(compare?baseline.map(f=>Math.abs(f.leads[lead])):[]))*1.15,[frames,baseline,lead,compare]);
 const path=(a:Frame[])=>a.filter((_,i)=>i%2===0).map((f,i)=>`${i?'L':'M'}${(24+f.t/duration*(W-38)).toFixed(2)},${(H/2-f.leads[lead]/range*46).toFixed(2)}`).join('');
 const d=useMemo(()=>path(frames),[frames,lead,range]),b=useMemo(()=>path(baseline),[baseline,lead,range]);
 const cursor=24+frames[index].t/duration*(W-38),gx=(W-38)/duration*.04,gy=46/range*.1;
 return <div className={'wave '+(selected?'selected':'')}><button className="lead-button" onClick={()=>onSelect(lead)} aria-label={'选择导联 '+lead}>{lead}</button><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={lead+'导联心电图，点击定位时间'} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();const x=(e.clientX-r.left)/r.width*W;onSeek(Math.max(0,Math.min(frames.length-1,Math.round((x-24)/(W-38)*(frames.length-1)))));onSelect(lead);}}>
  <defs><pattern id={'grid-'+lead} width={gx} height={gy} patternUnits="userSpaceOnUse"><path d={`M${gx} 0H0V${gy}`} fill="none" stroke="#efdae0" strokeWidth=".35"/></pattern><pattern id={'major-'+lead} width={gx*5} height={gy*5} patternUnits="userSpaceOnUse"><rect width={gx*5} height={gy*5} fill={`url(#grid-${lead})`}/><path d={`M${gx*5} 0H0V${gy*5}`} fill="none" stroke="#e8c8d1" strokeWidth=".6"/></pattern></defs>
  <rect width={W} height={H} fill={`url(#major-${lead})`}/><path d={`M10 ${H/2}v${-46/range}h8v${46/range}`} fill="none" stroke="#ac9097" strokeWidth="1"/>
  {compare&&<path d={b} stroke="#a4adb7" strokeWidth="1.3" strokeDasharray="3 3" fill="none"/>}<path d={d} stroke={selected?'#187f70':'#49545e'} strokeWidth="1.35" fill="none"/>
  <path d={`M${cursor} 0V${H}`} stroke="#8e77c2" strokeWidth="1"/><circle cx={cursor} cy={H/2-frames[index].leads[lead]/range*46} r="3" fill="#8e77c2"/>
 </svg><span className="wave-scale">±{range.toFixed(1)} mV · {duration.toFixed(1)} s</span></div>;
});
