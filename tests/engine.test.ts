import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cases} from '../src/cases';
import {LeadFieldModel} from '../src/vendor/LeadFieldModel';
import {generate,defaults,leads,norm,reconstruct,idealLeads,rotate,qrsName,type Frame} from '../src/engine';
const find=(id:string)=>cases.find(c=>c.id===id)!;
const all=new Map(cases.map(c=>[c.id,generate(c)]));
const at=(id:string,t:number)=>all.get(id)![Math.round(t*500)];
const energy=(f:Frame)=>Math.hypot(...leads.map(l=>f.leads[l]));
function support(id:string,a:number,b:number,threshold=.015){const w=all.get(id)!.filter(f=>f.t>=a&&f.t<=b);const cutoff=Math.max(...w.map(energy))*threshold;const active=w.filter(f=>energy(f)>cutoff);return {start:active[0]?.t??NaN,end:active.at(-1)?.t??NaN,duration:(active.at(-1)?.t??NaN)-(active[0]?.t??NaN)};}
function peaks(id:string){const a=all.get(id)!;const max=Math.max(...a.map(energy));const p:number[]=[];for(let i=1;i<a.length-1;i++){const e=energy(a[i]);if(e>max*.6&&e>=energy(a[i-1])&&e>energy(a[i+1])&&(p.length===0||a[i].t-p.at(-1)!>.22))p.push(a[i].t);}return p;}
const near=(a:number,b:number,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a} vs ${b}`);
test('volume conductor: analytic single-dipole voltage, sign reversal and perpendicular zero',()=>{
 const model=new LeadFieldModel(),p={x:.8,y:-.3,z:.4},f=model.compute12Leads(p,0,0),neg=model.compute12Leads({x:-p.x,y:-p.y,z:-p.z},0,0);
 const phi=(r:{x:number;y:number;z:number})=>1.085*.05*(r.x*p.x+r.y*p.y+r.z*p.z)/Math.hypot(r.x,r.y,r.z)**3;
 near(f.leads.II,phi(model.electrodes.LL)-phi(model.electrodes.RA));near(f.vWCT,(phi(model.electrodes.RA)+phi(model.electrodes.LA)+phi(model.electrodes.LL))/3);
 for(const l of leads)near(f.leads[l],-neg.leads[l]);const perpendicular=model.compute12Leads({x:0,y:1,z:0},0,0);near(perpendicular.leads.I,0);
});
test('all cases: finite 500-Hz output, exact limb identities and WCT chest reference at every sample',()=>{
 assert.ok(cases.length>=50);assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 for(const c of cases){const a=all.get(c.id)!;assert.equal(a.length,3001,c.id);assert.ok(a.some(f=>norm(f.vector)>.1),c.id);
  for(const f of a){for(const l of leads)assert.ok(Number.isFinite(f.leads[l]),c.id+':'+l);near(f.leads.I+f.leads.III,f.leads.II);near(f.leads.aVR,-(f.leads.I+f.leads.II)/2);near(f.leads.aVL,f.leads.I-f.leads.II/2);near(f.leads.aVF,f.leads.II-f.leads.I/2);near(f.leads.V1,f.potentials.V1-f.wct);}
 }
});
test('ideal triangle preserves augmented gain and Einthoven identities',()=>{
 const m=new LeadFieldModel(),v=idealLeads({x:0,y:1,z:0},m);near(v.I,0);near(v.II,Math.sqrt(3)/2);near(v.aVF,Math.sqrt(3)/2);near(v.I+v.III,v.II);
});
test('normal QRS and bundle block durations measured from output voltage support',()=>{
 const n=support('normal',.395,.57),r=support('rbbb',.395,.57),l=support('lbbb',.395,.57);
 assert.ok(n.duration>.07&&n.duration<.105,JSON.stringify(n));assert.ok(r.duration>.12&&r.duration>n.duration+.025,JSON.stringify(r));assert.ok(l.duration>.12,JSON.stringify(l));
 assert.ok(at('rbbb',.515).leads.V1>0,'terminal R prime in V1');assert.ok(at('rbbb',.515).leads.V6<0,'terminal S in V6');
});
test('PR measured from voltage onset: normal, first-degree and pre-excitation',()=>{
 const pr=(id:string)=>support(id,.395,.57).start-support(id,.10,.395).start;
 assert.ok(pr('normal')>.12&&pr('normal')<.21);assert.ok(pr('av1')>.23);assert.ok(pr('wpw')<.12);
});
test('Mobitz I progressive PR then dropped QRS; Mobitz II fixed PR with dropout',()=>{
 const pDuration=(id:string,i:number)=>{const base=.4+i*60/72;const p=support(id,base-.20,base-.03);const q=support(id,base-.005,base+.19);return q.start-p.start;};
 const a=[0,1,2].map(i=>pDuration('wenckebach',i));assert.ok(a[1]>a[0]+.03&&a[2]>a[1]+.03,JSON.stringify(a));
 assert.ok(energy(at('wenckebach',2.94))<.01,'fourth QRS absent');near(pDuration('mobitz2',0),pDuration('mobitz2',1),.004);assert.ok(energy(at('mobitz2',2.11))<.01,'third QRS absent');
});
test('complete AV block: atrial activity passes independently through ventricular clock',()=>{
 const p=peaks('av3');assert.ok(p.length>=3&&p.length<=4,JSON.stringify(p));const a=all.get('av3')!;assert.ok(a.some(f=>f.components.some(k=>k.phase==='P')&&f.components.some(k=>k.phase==='QRS')),'P overlaps QRS without fixed coupling');
});
test('AF has irregular ventricular intervals; flutter and SVT are faster than sinus',()=>{
 const p=peaks('af'),rr=p.slice(1).map((t,i)=>t-p[i]);assert.ok(Math.max(...rr)-Math.min(...rr)>.2,JSON.stringify(rr));assert.ok(peaks('flutter').length>peaks('normal').length);assert.ok(peaks('svt').length>peaks('flutter').length);
});
test('premature and escape timing come from signal peaks',()=>{
 const rr=60/72;for(const id of ['pac','pjc','pvc']){const p=peaks(id);assert.ok(p.some((t,i)=>i>0&&t-p[i-1]<rr-.15),id+':premature');}
 assert.ok(peaks('ventEscape')[0]>1.6,'escape follows pause');assert.ok(peaks('tachy').length>peaks('normal').length);assert.ok(peaks('brady').length<peaks('normal').length);
 const pp=peaks('pause');assert.ok(pp.some((t,i)=>i>0&&t-pp[i-1]>1.8));const sa=peaks('saBlock');assert.ok(sa.some((t,i)=>i>0&&Math.abs(t-sa[i-1]-2*rr)<.01));
});
test('chambers and axis: changes in actual lead voltage rather than labels',()=>{
 assert.ok(at('lvh',.448).leads.V5>at('normal',.448).leads.V5*1.5);
 assert.ok(at('rvh',.449).leads.V1>at('normal',.449).leads.V1);
 assert.ok(support('la',.20,.399).duration>support('normal',.20,.399).duration+.02);
 assert.ok(support('atrialDelay',.20,.399).duration>support('normal',.20,.399).duration+.02);
 assert.ok(at('ra',.279).leads.II>at('normal',.279).leads.II*1.5);
 assert.ok(at('lad',.448).leads.I>0&&at('lad',.448).leads.aVF<0);
 for(const id of ['rad','lpfb'])assert.ok(at(id,.448).leads.I<0&&at(id,.448).leads.aVF>0,id);
 assert.ok(at('lafb',.448).leads.aVF<0);
});
test('injury location, reciprocal ST and acute/evolving/old progression',()=>{
 for(const [id,lead] of [['anterior','V2'],['inferior','aVF'],['lateral','I']] as const){const a=at('mi-'+id,.55).leads[lead],e=at('mi-'+id+'-evolving',.55).leads[lead],o=at('mi-'+id+'-old',.55).leads[lead];assert.ok(a>.05&&e>0&&e<a&&Math.abs(o)<.01,JSON.stringify({id,a,e,o}));}
 assert.ok(at('mi-inferior',.55).leads.aVL<0);assert.ok(at('posterior',.55).leads.V2<0&&at('posterior',.55).extra.V9>0);assert.ok(at('rightMI',.55).extra.V4R>0);
 for(const id of ['ischemia','digitalis'])assert.ok(at(id,.55).leads.V5<0,id);
 assert.ok(at('pericarditis',.55).leads.II>0&&at('pericarditis',.55).leads.aVR<0);assert.ok(at('early',.51).leads.V4>0);
});
test('QT duration and electrolyte changes measured from recorded output',()=>{
 const end=(id:string)=>support(id,.59,1.02).end;
 assert.ok(end('highCa')<end('normal')-.06);assert.ok(end('lowCa')>end('normal')+.08);assert.ok(end('longQT')>end('normal')+.1);
 assert.ok(at('highK',.74).leads.II>at('normal',.74).leads.II);assert.ok(at('lowK',.87).leads.II>at('normal',.87).leads.II+.015);
});
test('electrode movement changes chest leads, not limb leads; camera is not an engine parameter',()=>{
 const changed=generate(find('normal'),{...defaults,offsetY:-6});for(const l of leads.slice(0,6))near(changed[224].leads[l],at('normal',.448).leads[l]);assert.notEqual(changed[224].leads.V1,at('normal',.448).leads.V1);
 const v={x:1,y:2,z:3};near(norm(rotate(v,80,40)),norm(v));near(at('placement',.448).leads.II,at('normal',.448).leads.II);
});
test('Kors published coefficients: independent scalar fixture, lead order and sign',()=>{
 const l={I:1,II:2,III:1,aVR:-1.5,aVL:0,aVF:1.5,V1:3,V2:4,V3:5,V4:6,V5:7,V6:8};const v=reconstruct(l);near(v.x,5.58);near(v.y,1.85);near(v.z,-2.07);
});
test('four genuine PTB-XL records retain header calibration and finite reconstruction',()=>{
 const index=JSON.parse(fs.readFileSync('public/data/index.json','utf8'));assert.equal(index.length,4);
 for(const item of index){const r=JSON.parse(fs.readFileSync(`public/data/ptbxl-${item.id}.json`,'utf8'));assert.equal(r.fs,500);assert.equal(r.samples.length,3000);assert.equal(r.leads.length,12);assert.ok(item.sha256.length===64);
  const header=fs.readFileSync(`public/data/${item.id}.hea`,'utf8').split(/\r?\n/).slice(1,13).map(l=>l.trim().split(/\s+/));
  header.forEach((s,i)=>{assert.equal(r.leads[i],s.at(-1));const gain=Number(s[2].split('(')[0]);near(r.samples[0][i],(Number(s[5])-Number(s[4]))/gain,.00001);});
  for(const row of r.samples){const l=Object.fromEntries(r.leads.map((k:string,i:number)=>[k,row[i]]));assert.ok(Number.isFinite(norm(reconstruct(l as any))));}}
});
test('QRS naming uses signed waveform sequence, not diagnostic labels',()=>{
 const make=(values:number[])=>values.map((v,i)=>({t:.4+i*.002,leads:{II:v}} as Frame));
 assert.equal(qrsName(make([-.2,.8,-.3]),'II'),'qRs');assert.equal(qrsName(make([-.8,-.7,-.1]),'II'),'QS');assert.equal(qrsName(make([.2,-1,.7]),'II'),'rSR′');
});
