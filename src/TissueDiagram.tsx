import {useState} from 'react';
import {qtDuration,type Frame} from './engine';
import type {Case} from './cases';
export function TissueDiagram({frame,clinical,onTime}:{frame:Frame;clinical:Case;onTime:(t:number)=>void}){
 const [mode,setMode]=useState<'depolarize'|'repolarize'>('depolarize');
 const rr=60/(clinical.hr||72),q=.4+Math.max(0,Math.round((frame.t-.4)/rr))*rr,u=frame.t-q,qt=qtDuration(clinical);
 const depol=mode==='depolarize',progress=Math.max(.05,Math.min(.95,depol?u/.092:(u-(qt-.19))/.19));
 const boundary=100+(depol?progress:1-progress)*520;
 return <section className="panel tissue-panel"><div className="tissue-copy"><span className="label-small">把波前方向与电偶方向分开看</span><h3>复极换了极性，也换了传播顺序。</h3><p>符号表示局部胞外相对电位。此处以一条心室壁示意：除极由心内膜侧向心外膜侧推进；复极可从心外膜侧先开始。</p><div className="segmented"><button className={depol?'active':''} onClick={()=>{setMode('depolarize');onTime(.446);}}>除极波前</button><button className={!depol?'active':''} onClick={()=>{setMode('repolarize');onTime(.4+qt-.095);}}>复极波前</button></div></div><div className="tissue-graphic"><svg viewBox="0 0 720 180" role="img" aria-label="除极复极的波前与电偶方向对照"><defs><marker id="tissue-forward" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#628c7d"/></marker><marker id="tissue-purple" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#9a84b6"/></marker></defs>
 <text x="100" y="17">心内膜侧</text><text x="620" y="17" textAnchor="end">心外膜侧</text><rect x="100" y="50" width={boundary-100} height="54" rx="5" fill="#e8e3f0"/><rect x={boundary} y="50" width={620-boundary} height="54" rx="5" fill="#e1eee7"/>
 {[0,1,2,3,4,5,6,7,8,9].map(i=>{const x=126+i*52;return <g key={i}><text x={x} y="84" textAnchor="middle" style={{fontSize:20,fill:x<boundary?'#9d85b6':'#6c9a83'}}>{x<boundary?'−':'＋'}</text></g>;})}
 <path d={`M${boundary} 37V115`} stroke="#9ca6ab" strokeDasharray="3 3"/>
 <text x="86" y="81" textAnchor="end">胞外</text>
 <path d={depol?`M${boundary-55} 33H${boundary+55}`:`M${boundary+55} 33H${boundary-55}`} stroke="#9a84b6" strokeWidth="2" markerEnd="url(#tissue-purple)"/><text x="360" y="132" textAnchor="middle">{depol?'左侧已除极，右侧尚未除极':'左侧尚未复极，右侧已复极'}</text>
 <path d="M290 155H430" stroke="#628c7d" strokeWidth="2.5" markerEnd="url(#tissue-forward)"/><text x="278" y="159" textAnchor="end">局部电偶 −</text><text x="443" y="159">＋</text><text x="670" y="38" textAnchor="end" style={{fill:'#9a84b6'}}>紫：波前</text>
 </svg><p>两种情况下，局部电偶均可指向同一侧；T 的真实形态还来自全心脏各处复极的合成。此图不表示细胞内跨膜电位。</p></div></section>;
}
