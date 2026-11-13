import {LeadFieldModel} from './vendor/LeadFieldModel';
import type {Vector3D,LeadId,PhysicalElectrodeId} from './vendor/types';
import type {Case} from './cases';
export type Vec=Vector3D;
export const leads:LeadId[]=['I','II','III','aVR','aVL','aVF','V1','V2','V3','V4','V5','V6'];
export const zero=():Vec=>({x:0,y:0,z:0});
export const add=(a:Vec,b:Vec):Vec=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
export const scale=(a:Vec,s:number):Vec=>({x:a.x*s,y:a.y*s,z:a.z*s});
export const dot=(a:Vec,b:Vec)=>a.x*b.x+a.y*b.y+a.z*b.z;
export const norm=(a:Vec)=>Math.hypot(a.x,a.y,a.z);
export const unit=(a:Vec)=>scale(a,1/(norm(a)||1));
export function rotate(v:Vec,frontal:number,horizontal:number):Vec {const a=frontal*Math.PI/180,b=horizontal*Math.PI/180;const x=v.x*Math.cos(a)-v.y*Math.sin(a),y=v.x*Math.sin(a)+v.y*Math.cos(a);return {x:x*Math.cos(b)+v.z*Math.sin(b),y,z:-x*Math.sin(b)+v.z*Math.cos(b)};}
export type Phase='P'|'PR'|'QRS'|'ST'|'T'|'U'|'静息'|'连续活动';
export const colors:Record<string,string>={P:'#c18b26',PR:'#a7a9b1',QRS:'#1c8a79',ST:'#bc7254',T:'#8171c5',U:'#bc83b5','静息':'#a7a9b1','连续活动':'#1c8a79'};
export interface Component {name:string;vector:Vec;phase:Phase;activity:number}
export interface Frame {t:number;vector:Vec;components:Component[];phase:Phase;leads:Record<LeadId,number>;potentials:Record<PhysicalElectrodeId,number>;wct:number;extra:Record<string,number>}
export interface Controls {model:'field'|'ideal';frontal:number;horizontal:number;electrode:string;offsetX:number;offsetY:number;manual:boolean;azimuth:number;elevation:number;magnitude:number}
export const defaults:Controls={model:'field',frontal:0,horizontal:0,electrode:'V1',offsetX:0,offsetY:0,manual:false,azimuth:45,elevation:20,magnitude:1};
export interface Event {p:number|null;q:number|null;wide?:boolean;ectopic?:boolean;junction?:boolean}
export function eventsFor(c:Case,duration=6):Event[]{
 const rhythm=c.rhythm||'sinus',hr=c.hr||72,rr=60/hr,events:Event[]=[];
 if(['vf','vflutter'].includes(rhythm))return events;
 if(rhythm==='av3'){
  for(let q=.4;q<duration+1;q+=60/35)events.push({q,p:null,wide:true});
  for(let p=.32;p<duration+1;p+=.8)events.push({p,q:null});return events;
 }
 if(rhythm==='ventEscape'){for(let q=1.65;q<duration+1;q+=60/35)events.push({q,p:null,wide:true,ectopic:true});return events;}
 let q=.4;
 for(let i=0;q<duration+1&&i<40;i++){
  let pr=c.conduction==='wpw'?.09:rhythm==='av1'?.27:.16;
  let ventricular=q, p:number|null=q-pr;
  if(rhythm==='wenckebach'){pr=.16+(i%4)*.055;ventricular=q+pr-.16;p=q-.16;}
  if((rhythm==='wenckebach'&&i%4===3)||(rhythm==='mobitz2'&&i%3===2)){events.push({p,q:null});}
  else if(rhythm==='saBlock'&&i===3){/* one impulse fails to exit */}
  else if(rhythm==='pause'&&i===3){q+=.28;}
  else{
   let ectopic=false,junction=false,wide=false;
   if(['pac','pjc','pvc'].includes(rhythm)&&i===3){ventricular-=.30;ectopic=true;junction=rhythm==='pjc';wide=rhythm==='pvc';p=wide?null:ventricular-(junction?.07:.16);}
   if(['af','flutter','svt','vt','junctionEscape'].includes(rhythm))p=null;
   if(rhythm==='junctionEscape'){p=ventricular-.06;junction=true;}
   events.push({q:ventricular,p,ectopic,wide:wide||rhythm==='vt',junction});
   if((rhythm==='pac'||rhythm==='pjc')&&i===3)q-=.30;
  }
  const interval=rhythm==='af'?rr*(.66+.72*(.5+.5*Math.sin(i*7.13+1.1))):rhythm==='sinusIrregular'?rr*(1+.16*Math.sin(i*1.1)):rr;
  q+=interval;
 }
 return events;
}
const pulse=(u:number,a:number,b:number)=>u<=a||u>=b?0:Math.sin(Math.PI*(u-a)/(b-a))**2;
const smooth=(x:number)=>{const z=Math.max(0,Math.min(1,x));return z*z*(3-2*z);};
const plateau=(u:number,a:number,b:number)=>smooth((u-a)/.018)*(1-smooth((u-b)/.035));
export function qrsDuration(c:Case,ev?:Event){return ev?.wide ? .16 : c.conduction==='rbbb'||c.conduction==='lbbb' ? .15 : c.conduction==='wpw' ? .13 : c.electrolyte==='highK' ? .135 : .092;}
export function qtDuration(c:Case){return c.electrolyte==='highCa' ? .29 : c.electrolyte==='lowCa' ? .51 : c.electrolyte==='longQT' ? .54 : c.injury==='digitalis' ? .34 : .40*Math.min(1,Math.pow(60/(c.hr||72),.33));}
const injuryVector=(c:Case):Vec=>c.injury==='inferior'?{x:-.08,y:.22,z:0}:c.injury==='lateral'?{x:.13,y:-.025,z:0}:c.injury==='posterior'?{x:0,y:0,z:.08}:c.injury==='right'?{x:-.06,y:.02,z:-.07}:c.injury==='ischemia'?{x:-.055,y:-.04,z:.015}:c.injury==='pericarditis'?{x:.055,y:.075,z:-.045}:c.injury==='early'?{x:.025,y:.018,z:-.025}:c.injury==='digitalis'?{x:-.055,y:-.04,z:.005}:c.injury==='anterior'?{x:.015,y:.005,z:-.08}:zero();
export function componentsAt(t:number,c:Case,events:Event[]):Component[]{
 const out:Component[]=[];
 const put=(name:string,v:Vec,a:number,phase:Phase)=>{if(a>1e-6)out.push({name,vector:scale(v,a),activity:a,phase});};
 const r=c.rhythm;
 if(r==='vf'||r==='vflutter'){
  const v=r==='vflutter'?{x:.8*Math.sin(t*27),y:.6*Math.sin(t*27+.3),z:.4*Math.sin(t*27+.7)}:{x:.38*Math.sin(t*37)+.21*Math.sin(t*51+1),y:.45*Math.sin(t*43+.8)+.18*Math.sin(t*31),z:.31*Math.sin(t*39+1.9)+.13*Math.sin(t*59)};
  return [{name:r==='vf'?'无序心室活动':'连续心室振荡',vector:v,activity:1,phase:'连续活动'}];
 }
 for(const ev of events){
  if(ev.p!==null){const u=t-ev.p;const enlarged=c.chamber==='la',delayed=c.chamber==='atrialDelay';const late=(enlarged||delayed)?.045:0;const pGain=c.electrolyte==='highK'?.3:1;const sign=ev.junction?-1:1;
   put('右心房',ev.ectopic&&!ev.junction?{x:-.12,y:.08,z:-.03}:{x:.075,y:.125,z:-.025},pulse(u,0,.078)*(c.chamber==='ra'?2.6:1)*pGain*sign,'P');
   put('左心房',{x:.09,y:.065,z:.065},pulse(u,.025+late,.105+late)*(enlarged?1.8:1)*pGain*sign,'P');
  }
  if(ev.q===null)continue;
  const u=t-ev.q,d=qrsDuration(c,ev),w=d/.092,vt=ev.wide||c.rhythm==='vt',qt=qtDuration(c);
  if(u<-.07||u>qt+.2)continue;
  if(c.conduction==='wpw')put('旁路提前激动',{x:.32,y:.30,z:-.18},pulse(u,0,.060),'QRS');
  let lv:Vec={x:.95,y:.74,z:.66},rv:Vec={x:-.15,y:.07,z:-.12},septum:Vec={x:-.11,y:-.025,z:-.10};
  if(c.chamber==='lv')lv=scale(lv,1.8);
  if(c.chamber==='rv')rv={x:-1.1,y:.78,z:-1.4};
  if(c.conduction==='lbbb')septum={x:.10,y:.03,z:.07};
  if(c.injury==='anterior')lv=scale(lv,c.stage==='acute'?.85:.65);
  if(vt){lv={x:-.95,y:-.72,z:.5};rv={x:.24,y:.15,z:-.15};}
  put('室间隔',septum,pulse(u,0,.029*w),'QRS');
  put('左心室主体',lv,pulse(u,c.conduction==='lbbb'?.035:.016*w,.080*w),'QRS');
  put('右心室',rv,pulse(u,.027*w,c.conduction==='rbbb'?.14:.083*w),'QRS');
  if(c.conduction==='rbbb')put('延迟右室',{x:-.45,y:.06,z:-.48},pulse(u,.075,.15),'QRS');
  put('心室基底部',{x:-.17,y:-.23,z:.18},pulse(u,.066*w,d),'QRS');
  const injury=injuryVector(c),isMI=!!c.stage;
  if(isMI&&!['posterior','right'].includes(c.injury||''))put('初始有效贡献缺失（等效差值）',scale(unit(injury),-.38),pulse(u,0,.04),'QRS');
  if(c.injury){const amp=c.stage==='old'?0:c.stage==='evolving'?.28:1;const st=plateau(u,d+.004,.19);put('ST 损伤 / 复极差异',injury,st*amp,'ST');
   if(c.injury==='pericarditis')put('PR 段差异',scale(injury,-.25),plateau(u,-.052,-.02),'PR');
   if(c.injury==='early')put('J 点贡献',scale(injury,1.3),pulse(u,d-.01,d+.03),'ST');
  }
  let tv:Vec={x:.27,y:.31,z:.10},ta=1;
  if(vt||c.chamber==='lv'||c.conduction==='lbbb')tv={x:-.29,y:-.25,z:-.06};
  if(c.conduction==='rbbb')tv={x:.24,y:.24,z:.23};
  if(c.chamber==='rv')tv={x:.08,y:.08,z:.24};
  if(c.stage==='evolving'||c.injury==='ischemia')tv=scale(unit(injury),-.25);
  if(c.electrolyte==='highK')ta=2.5;
  if(c.electrolyte==='lowK')ta=.25;
  const tStart=c.electrolyte==='highK'?qt-.105:qt-.19;
  put('心室复极',tv,pulse(u,tStart,qt)*ta,'T');
  if(c.electrolyte==='lowK'){put('晚期 U 贡献（机制未定）',{x:.10,y:.12,z:.025},pulse(u,qt+.015,qt+.18),'U');put('低钾 ST 差异',{x:-.025,y:-.025,z:0},plateau(u,d+.008,.19),'ST');}
 }
 if(r==='af')put('连续房性活动',{x:.03*Math.sin(t*39)+.015*Math.sin(t*51),y:.035*Math.sin(t*35+1),z:.03*Math.sin(t*47+.8)},1,'连续活动');
 if(r==='flutter'){const saw=((t*5)%1)-.5;put('心房扑动',{x:-.12*saw,y:-.20*saw,z:.04*saw},1,'连续活动');}
 return out;
}
export function createModel(c:Case,controls:Controls){
 const field=new LeadFieldModel();
 if(c.misplaced)for(const id of ['V1','V2'] as PhysicalElectrodeId[])field.setElectrodePosition(id,{...field.electrodes[id],y:-.07},false);
 const id=controls.electrode as PhysicalElectrodeId;
 field.setElectrodePosition(id,{...field.electrodes[id],x:field.electrodes[id].x+controls.offsetX/100,y:field.electrodes[id].y+controls.offsetY/100},false);
 return field;
}
// Equal-sided limb triangle for the ideal model. Augmented axes retain their sqrt(3)/2 gain.
export function idealLeads(v:Vec,field:LeadFieldModel):Record<LeadId,number>{
 const I=v.x,II=.5*v.x+Math.sqrt(3)/2*v.y,III=II-I;
 return {I,II,III,aVR:-(I+II)/2,aVL:I-II/2,aVF:II-I/2,...Object.fromEntries(leads.slice(6).map(l=>[l,dot(v,unit(field.electrodes[l as PhysicalElectrodeId]))]))} as Record<LeadId,number>;
}
export function leadCoefficients(c:Case,controls:Controls,lead:LeadId):Vec {
 const field=createModel(c,controls);const value=(v:Vec)=>controls.model==='field'?field.compute12Leads(v,0,0).leads[lead]:idealLeads(v,field)[lead];return {x:value({x:1,y:0,z:0}),y:value({x:0,y:1,z:0}),z:value({x:0,y:0,z:1})};
}
export function qrsName(frames:Frame[],lead:LeadId,start=.395,end=.57):string {
 const window=frames.filter(f=>f.t>=start&&f.t<=end),threshold=.025;
 const runs:{sign:number;amp:number}[]=[];
 for(const f of window){const v=f.leads[lead];if(Math.abs(v)<threshold)continue;const sign=Math.sign(v),last=runs.at(-1);if(last?.sign===sign)last.amp=Math.max(last.amp,Math.abs(v));else runs.push({sign,amp:Math.abs(v)});}
 if(!runs.some(r=>r.sign>0))return runs.length?'QS':'近等电位';
 let positive=0;return runs.map((r,i)=>{const letter=r.sign>0?(positive++?'R′':'R'):i===0?'Q':'S';return r.amp>=.5?letter:letter.toLowerCase();}).join('');
}
export function generate(c:Case,controls:Controls=defaults,duration=6,fs=500):Frame[]{
 const field=createModel(c,controls),events=eventsFor(c,duration),out:Frame[]=[];
 for(let i=0;i<=duration*fs;i++){
  const t=i/fs;
  let components=componentsAt(t,c,events).map(k=>({...k,vector:rotate(k.vector,controls.frontal+(k.phase==='P'?0:c.axis||0),controls.horizontal)}));
  if(controls.manual){const a=controls.azimuth*Math.PI/180,e=controls.elevation*Math.PI/180;components=[{name:'手动电偶',phase:'连续活动',activity:1,vector:{x:controls.magnitude*Math.cos(e)*Math.cos(a),y:controls.magnitude*Math.cos(e)*Math.sin(a),z:controls.magnitude*Math.sin(e)}}];}
  const vector=components.reduce((a,k)=>add(a,k.vector),zero());const f=field.compute12Leads(vector,0,t*1000);
  const active=components.filter(k=>norm(k.vector)>.012).sort((a,b)=>norm(b.vector)-norm(a.vector));
  let phase:Phase=active[0]?.phase||'静息';
  if(phase==='静息'&&events.some(e=>e.p!==null&&e.q!==null&&t>e.p+.105&&t<e.q))phase='PR';
  const wctVector=scale(add(add(field.electrodes.RA,field.electrodes.LA),field.electrodes.LL),1/3);void wctVector;
  const potential=(r:Vec)=>1.085*.05*dot(r,vector)/(norm(r)**3);
  const extra=Object.fromEntries(Object.entries({V7:{x:.14,y:.06,z:.08},V8:{x:.1,y:.06,z:.13},V9:{x:.04,y:.06,z:.15},V3R:{x:-.06,y:.03,z:-.10},V4R:{x:-.10,y:.06,z:-.08}}).map(([id,r])=>[id,controls.model==='field'?potential(r)-f.vWCT:dot(vector,unit(r))]));
  out.push({t,vector,components,phase,leads:controls.model==='field'?f.leads:idealLeads(vector,field),potentials:f.unipolar,wct:f.vWCT,extra});
 }
 return out;
}
// Kors regression: input order I, II, V1..V6; output +X left, +Y inferior, +Z posterior.
export const KORS=[ [.38,-.07,-.13,.05,-.01,.14,.06,.54],[-.07,.93,.06,-.02,-.05,.06,-.17,.13],[.11,-.23,-.43,-.06,-.14,-.20,-.11,.31] ];
export function reconstruct(l:Record<LeadId,number>):Vec {const v=[l.I,l.II,l.V1,l.V2,l.V3,l.V4,l.V5,l.V6];const [x,y,z]=KORS.map(row=>row.reduce((a,k,i)=>a+k*v[i],0));return {x,y,z};}
export function measure(frames:Frame[],lead:LeadId){
 const vals=frames.map(f=>f.leads[lead]);return {max:Math.max(...vals),min:Math.min(...vals),rs:Math.max(...vals)/(Math.abs(Math.min(...vals))||1),axis:Math.atan2(frames.reduce((s,f)=>s+(f.phase==='QRS'?f.vector.y:0),0),frames.reduce((s,f)=>s+(f.phase==='QRS'?f.vector.x:0),0))*180/Math.PI};
}
