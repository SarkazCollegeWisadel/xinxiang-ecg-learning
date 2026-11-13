import * as THREE from 'three';
import {toCreasedNormals,mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {createAtlasCardiacModelModel,type ProceduralModelRuntime} from './GeneratedHeart';
import spec from './heart-runtime.json';
export const MODEL_STAGE=7;
// [start longitudinal position, start angle, end position, end angle, radius].
// Atlas-based epicardial courses; these are anatomical teaching approximations.
export const coronaryBranches:Record<string,{parent:string;vein?:boolean;path:number[]}>=Object.fromEntries([
 ['diagonal-1','lad',.16,1.13,.38,.50,.014],['diagonal-2','lad',.35,1.13,.59,.35,.012],['diagonal-3','lad',.56,1.13,.77,.43,.010],
 ['rv-anterior-1','lad',.20,1.13,.36,1.77,.010],['rv-anterior-2','lad',.45,1.13,.60,1.94,.009],
 ['acute-marginal','rca',.015,2.56,.73,2.10,.016],['rv-marginal-1','branch-acute-marginal',.22,2.428,.40,1.88,.009],['rv-marginal-2','branch-acute-marginal',.46,2.274,.65,1.78,.008],
 ['obtuse-marginal','lcx',.025,-.22,.75,.10,.015],['lateral-1','branch-obtuse-marginal',.20,-.143,.42,-.62,.010],['lateral-2','branch-obtuse-marginal',.45,-.032,.67,-.54,.009],
 ['posterior-lv-1','posterior-artery',.17,-1.10,.39,-.40,.012],['posterior-lv-2','posterior-artery',.40,-1.10,.63,-.42,.010],['posterior-rv-1','posterior-artery',.23,-1.10,.43,-1.90,.011],['posterior-rv-2','posterior-artery',.51,-1.10,.70,-1.92,.009],
 ['diagonal-vein-1','great-vein',.21,1.24,.41,.57,.012],['diagonal-vein-2','great-vein',.45,1.24,.64,.49,.010],
 ['posterior-vein','coronary-sinus',.06,-1.24,.84,-1.24,.016],['lateral-vein','coronary-sinus',.065,-.32,.73,-.05,.013],
].map(([id,parent,t0,a0,t1,a1,r])=>['branch-'+id,{parent:parent as string,vein:String(id).includes('vein'),path:[t0,a0,t1,a1,r] as number[]}]));
function surfaceBranch(path:number[]){const [t0,a0,t1,a1,r]=path;const curve=new THREE.CatmullRomCurve3(Array.from({length:28},(_,i)=>{const u=i/27;return ventPoint(t0+(t1-t0)*u,a0+(a1-a0)*u,.010);}));const n=40,s=10,g=new THREE.TubeGeometry(curve,n,r,s,false),a=g.attributes.position;
 for(let i=0;i<=n;i++){const u=i/n,c=curve.getPointAt(u),scale=1-.79*Math.pow(u,.8);for(let j=0;j<=s;j++){const k=i*(s+1)+j;a.setXYZ(k,c.x+(a.getX(k)-c.x)*scale,c.y+(a.getY(k)-c.y)*scale,c.z+(a.getZ(k)-c.z)*scale);}}g.computeVertexNormals();return g;}
export interface HeartModel extends THREE.Group {userData:Record<string,any>&{sculptRuntime:ProceduralModelRuntime}}
const rings=spec.medicalReconstruction.sharedVentricularLoft.rings;
function interp(t:number,values:number[][]){const f=Math.max(0,Math.min(.999999,t))*(values.length-1),i=Math.floor(f),u=f-i;return values[0].map((_,j)=>{const a=values[Math.max(0,i-1)][j],b=values[i][j],c=values[Math.min(values.length-1,i+1)][j],d=values[Math.min(values.length-1,i+2)][j];return .5*((2*b)+(-a+c)*u+(2*a-5*b+4*c-d)*u*u+(-a+3*b-3*c+d)*u*u*u);});}
export function ventPoint(t:number,theta:number,offset=0):THREE.Vector3{const [y,cx,rx,rz]=interp(t,rings);return new THREE.Vector3(cx+(Math.max(.001,rx)+offset)*Math.cos(theta),y,(Math.max(.001,rz)+offset)*Math.sin(theta));}
function vesselWall(curve:THREE.Curve<THREE.Vector3>,r:number):THREE.BufferGeometry{
 const n=36,s=24,outer=new THREE.TubeGeometry(curve,n,r,s,false),inner=new THREE.TubeGeometry(curve,n,r*.78,s,false),p=[...outer.attributes.position.array,...inner.attributes.position.array],count=outer.attributes.position.count,idx=[...outer.index!.array];
 for(let i=0;i<inner.index!.count;i+=3)idx.push(count+inner.index!.getX(i),count+inner.index!.getX(i+2),count+inner.index!.getX(i+1));
 for(let j=0;j<s;j++){let a=j,b=j+1,c=a+count,d=b+count;idx.push(a,b,c,b,d,c);a=n*(s+1)+j;b=a+1;c=a+count;d=b+count;idx.push(a,c,b,b,c,d);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();outer.dispose();inner.dispose();const result=toCreasedNormals(g,Math.PI/4);g.dispose();return result;
}
function adiposeBand(kind:'anterior'|'av'|'posterior'){
 const n=44,w=6,positions:number[]=[],indices:number[]=[],edges=new Map<string,[number,number]|null>();
 for(const offset of [.012,.001])for(let i=0;i<=n;i++)for(let j=0;j<=w;j++){const u=i/n,v=j/w-.5,half=.45+.075*Math.sin(u*37);const p=kind==='av'?ventPoint(.065+v*.12,1.05+u*4.4,offset):ventPoint(.025+u*.87,(kind==='anterior'?1.15:-1.1)+v*half,offset);positions.push(p.x,p.y,p.z);}
 const count=(n+1)*(w+1);const face=(a:number,b:number,c:number)=>{indices.push(a,b,c);for(const [x,y] of [[a,b],[b,c],[c,a]]){const key=Math.min(x,y)+':'+Math.max(x,y);edges.set(key,edges.has(key)?null:[x,y]);}};
 for(let i=0;i<n;i++)for(let j=0;j<w;j++){const a=i*(w+1)+j,b=a+1,c=a+w+1,d=c+1;if(kind==='av'){face(a,c,b);face(b,c,d);}else{face(a,b,c);face(b,d,c);}}
 const exterior=indices.slice();for(let k=0;k<exterior.length;k+=3)indices.push(count+exterior[k],count+exterior[k+2],count+exterior[k+1]);for(const edge of edges.values())if(edge){const [a,b]=edge;indices.push(b,a,a+count,b,a+count,b+count);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();const result=toCreasedNormals(g,Math.PI/4);g.dispose();return result;
}
function loft(values:number[][],start=0,end=2*Math.PI,vertical=64,radial=52):THREE.BufferGeometry{
 const p:number[]=[],uv:number[]=[],idx:number[]=[];
 for(let i=0;i<=vertical;i++){const t=i/vertical,[y,cx,rx,rz,cz=0]=interp(t,values);for(let j=0;j<=radial;j++){const a=start+(end-start)*j/radial;p.push(cx+Math.max(.001,rx)*Math.cos(a),y,cz+Math.max(.001,rz)*Math.sin(a));uv.push(j/radial,t);}p.push(cx,y,cz);uv.push(.5,t);}
 const stride=radial+2;
 for(let i=0;i<vertical;i++)for(let j=0;j<radial;j++){const a=i*stride+j,b=a+1,c=a+stride,d=c+1;idx.push(a,b,c,b,d,c);}
 if(end-start<Math.PI*2-.0001)for(let i=0;i<vertical;i++){const c=i*stride+radial+1,d=c+stride,a=i*stride,b=a+stride,e=a+radial,f=b+radial;idx.push(a,b,c,c,b,d,e,c,f,c,d,f);}
 for(let j=0;j<radial;j++){idx.push(radial+1,j+1,j);const a=vertical*stride;idx.push(a+radial+1,a+j,a+j+1);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();const result=toCreasedNormals(g,Math.PI/4);g.dispose();return result;
}
function buildMedicalHeart():HeartModel{
 const root=createAtlasCardiacModelModel({castShadow:true,receiveShadow:true}) as HeartModel;
 const runtime=root.userData.sculptRuntime;
 Object.values(runtime.nodes).forEach(n=>{n.position.set(0,0,0);n.quaternion.identity();n.scale.set(1,1,1);});
 Object.entries(runtime.meshes).forEach(([id,m])=>{m.visible=MODEL_STAGE>0||['lv','rv','ra','la','auricle-right','auricle-left'].includes(id);if(id==='root')m.visible=false;m.position.set(0,0,0);m.quaternion.identity();m.scale.set(1,1,1);m.userData.partId=id;for(const material of Array.isArray(m.material)?m.material:[m.material])material.dispose();m.material=new THREE.MeshPhysicalMaterial({color:'#cd9991',roughness:.56,metalness:0});});
 function replace(id:string,g:THREE.BufferGeometry){const mesh=runtime.meshes[id];mesh.geometry.dispose();mesh.geometry=g;return mesh;}
 replace('lv',loft(rings,-2.613185307179586,1.13));replace('rv',loft(rings,1.13,3.67));
 replace('ra',loft([[.70,-.54,.015,.015,-.03],[.60,-.55,.19,.15,-.02],[.39,-.53,.29,.22,.01],[.13,-.56,.25,.19,.12],[-.15,-.58,.18,.13,.23],[-.36,-.55,.085,.07,.23],[-.43,-.49,.001,.001,.20]]));
 replace('la',loft([[.72,.15,.01,.01,-.32],[.61,.13,.27,.19,-.32],[.43,.10,.37,.25,-.32],[.18,.10,.27,.17,-.31],[.10,.09,.01,.01,-.30]]));
 replace('auricle-right',loft([[.54,-.40,.01,.01,.25],[.48,-.40,.24,.11,.28],[.37,-.44,.29,.14,.31],[.26,-.52,.20,.08,.31],[.23,-.58,.01,.01,.28]],0,Math.PI*2,36,36));
 replace('auricle-left',loft([[.55,.40,.01,.01,.22],[.48,.40,.18,.10,.25],[.35,.46,.18,.12,.28],[.30,.53,.01,.01,.25]],0,Math.PI*2,32,32));
 // Great-vessel paths are root-local, unlike the generic emitter's straight attachment proxy.
 for(const c of spec.componentTree){const path=(c.geometryDescriptor as any).medicalPath;if(!path)continue;const points=path.points.map((p:number[])=>new THREE.Vector3(...p as [number,number,number]));const curve=c.id==='pulmonary-right'?new THREE.LineCurve3(points[0],points.at(-1)!):new THREE.CatmullRomCurve3(points,false,'centripetal');const mesh=replace(c.id,MODEL_STAGE>=2?vesselWall(curve,path.radius):new THREE.TubeGeometry(curve,56,path.radius,20,false));mesh.visible=true;}
 const coronaryPath=(id:string)=>Array.from({length:28},(_,i)=>{const u=i/27;return id==='rca'?ventPoint(.015,1.1+u*2.6,.01):id==='lcx'?ventPoint(.025,.85-u*3.85,.012):id==='coronary-sinus'?ventPoint(.065,-.25-u*2.85,.02):ventPoint(.03+u*.87,id==='posterior-artery'?-1.10:id==='great-vein'?1.24:1.13,.009);});
 if(MODEL_STAGE>=1)for(const id of ['lad','rca','lcx','great-vein','coronary-sinus','posterior-artery']){const curve=new THREE.CatmullRomCurve3(coronaryPath(id));replace(id,new THREE.TubeGeometry(curve,70,id==='coronary-sinus'?.035:id==='great-vein'?.024:.022,10,false));}
 if(MODEL_STAGE>=2)for(const id of ['auricle-right','auricle-left']){const g=runtime.meshes[id].geometry,a=g.attributes.position;for(let i=0;i<a.count;i++){const x=a.getX(i),y=a.getY(i),z=a.getZ(i);if(z>.27)a.setZ(i,z+.012*Math.sin(x*48+y*21)*Math.sin(Math.max(0,y-.24)*10));}g.computeVertexNormals();runtime.meshes[id].geometry=toCreasedNormals(g,Math.PI/4);g.dispose();}
 if(MODEL_STAGE>=3){
  for(const c of spec.componentTree){const m=runtime.meshes[c.id];if(!m)continue;const material=spec.materials.find(x=>x.id===c.material)!;const old=m.material as THREE.Material;old.dispose();m.material=new THREE.MeshPhysicalMaterial({color:material.color,roughness:MODEL_STAGE>=5?(c.material==='myocardium'?.58:.50):(c.material==='myocardium'?.47:.41),metalness:0,clearcoat:MODEL_STAGE>=5?.045:.13,clearcoatRoughness:.52});}
  for(const kind of ['anterior','av','posterior'] as const){const id='fat-'+kind,node=new THREE.Group();node.name=id+'__pivot';const mesh=new THREE.Mesh(adiposeBand(kind),new THREE.MeshPhysicalMaterial({color:'#dfc47f',roughness:.61,metalness:0}));mesh.name=id;mesh.userData.partId=id;mesh.userData.explodeWithParent=true;node.add(mesh);runtime.nodes.lv.add(node);runtime.nodes[id]=node;runtime.meshes[id]=mesh;}
 }
 if(MODEL_STAGE>=4){
  const add=(id:string,parent:string,geometry:THREE.BufferGeometry,material:THREE.Material)=>{const node=new THREE.Group(),mesh=new THREE.Mesh(geometry,material);node.name=id+'__pivot';mesh.name=id;mesh.userData={partId:id,anatomicalParent:parent,explodeWithParent:true};node.add(mesh);runtime.nodes[parent].add(node);runtime.nodes[id]=node;runtime.meshes[id]=mesh;};
  for(const [id,b] of Object.entries(coronaryBranches))add(id,b.parent,surfaceBranch(b.path),new THREE.MeshPhysicalMaterial({color:b.vein?'#456d9e':'#b63a34',roughness:.53,metalness:0,clearcoat:.04}));
  // Short, shallow relief follows the illustrated oblique fiber strokes. No random noise,
  // pores or asserted histological fiber field is inferred from a two-view illustration.
  for(const side of ['anterior','posterior'])for(const chamber of ['lv','rv']){const strokes:THREE.BufferGeometry[]=[];
   for(let row=0;row<6;row++)for(let col=0;col<9;col++){const t=.12+row*.112,a=(side==='anterior'?.18:-2.85)+col*.30;
    if(side==='anterior'&&Math.abs(a-1.15)<.21||side==='posterior'&&Math.abs(a+1.1)<.21)continue;
    const isRv=(angle:number)=>angle>1.13||angle< -2.613185307179586;if(isRv(a)!==(chamber==='rv')||isRv(a)!==isRv(a-.15))continue;
    const curve=new THREE.CatmullRomCurve3(Array.from({length:10},(_,i)=>ventPoint(t+i/9*.063,a-i/9*.15,.0025)));strokes.push(new THREE.TubeGeometry(curve,14,.0018,5,false));}
   const geometry=mergeGeometries(strokes)!;strokes.forEach(g=>g.dispose());add('fiber-'+side+(chamber==='rv'?'-rv':''),chamber,geometry,new THREE.MeshStandardMaterial({color:'#c27369',roughness:.73,metalness:0}));
  }
 }
 if(MODEL_STAGE>=6){
  Object.values(runtime.sockets).forEach(s=>s.removeFromParent());runtime.sockets={};runtime.colliders={};runtime.destructionGroups={};
  for(const [id,mesh] of Object.entries(runtime.meshes)){if(id==='root')continue;const c=spec.componentTree.find(c=>c.id===id);mesh.geometry.computeBoundingBox();const bounds=mesh.geometry.boundingBox!,center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),node=runtime.nodes[id];
   let start=center.clone(),end=center.clone();const b=coronaryBranches[id],path=(c?.geometryDescriptor as any)?.medicalPath;
   if(b){start=ventPoint(b.path[0],b.path[1],.01);end=ventPoint(b.path[2],b.path[3],.01);}
   else if(path){start.fromArray(path.points[0]);end.fromArray(path.points.at(-1));}
   else if(['lad','rca','lcx','great-vein','coronary-sinus','posterior-artery'].includes(id)){const ps=coronaryPath(id);start=ps[0];end=ps.at(-1)!;}
   else if(id.startsWith('fat-')){const av=id==='fat-av',a=id==='fat-posterior'?-1.1:1.15;start=ventPoint(av?.065:.025,av?1.05:a,.006);end=ventPoint(av?.065:.895,av?5.45:a,.006);}
   const socket=new THREE.Object3D();socket.name=id+'-surface-root';socket.position.copy(start);node.add(socket);runtime.sockets[socket.name]=socket;
   const collider={type:'box',offset:center.toArray(),scale:size.toArray(),isTrigger:false,notes:'Actual local geometry AABB proxy; no physics solver enabled.'};runtime.colliders[id]=collider;
   node.userData.actionProfile={...c?.actionProfile,pivot:{mode:'custom',localPosition:[0,0,0],axis:[0,1,0],confidence:.8},collider,sockets:[{id:socket.name,localPosition:start.toArray()}],destruction:{breakable:false,fractureGroup:id,seamRefs:[],detachableFragments:[]}};
   mesh.userData.sculptComponent=c;mesh.userData.actualAttachment={parent:c?.parent||'root',localStart:start.toArray(),localEnd:end.toArray(),parentSocket:socket.name};
  }
 }
 root.scale.x=1.1; // atlas-observed transverse / longitudinal proportion, not a camera distortion
 root.userData.modelSource={skill:'img2threejs 2.0.1',spec:'modeling/heart-spec.json',reference:'OpenStax College CC BY 3.0',scope:'atlas-based procedural reconstruction'};
 return root;
}
// Build the high-resolution loft and creased normals once. Instances own their
// buffers and materials, so scene teardown and emissive highlighting stay isolated.
let prototype:HeartModel|undefined,prototypeBuildMs=0;
export function createMedicalHeart():HeartModel{
 if(!prototype){const before=performance.now();prototype=buildMedicalHeart();prototypeBuildMs=performance.now()-before;}
 const before=performance.now(),source=prototype,sourceData=source.userData,r=sourceData.sculptRuntime;
 let root:HeartModel;(source as THREE.Group).userData={modelSource:sourceData.modelSource};
 try{root=source.clone(true) as HeartModel;}finally{source.userData=sourceData;}
 const originals:THREE.Object3D[]=[],copies:THREE.Object3D[]=[],mapping=new Map<THREE.Object3D,THREE.Object3D>();source.traverse(o=>originals.push(o));root.traverse(o=>copies.push(o));originals.forEach((o,i)=>mapping.set(o,copies[i]));
 root.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry=o.geometry.clone();o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();}});
 const mapNodes=(items:Record<string,THREE.Object3D>)=>Object.fromEntries(Object.entries(items).map(([id,o])=>[id,mapping.get(o)!]));
 root.userData.sculptRuntime={nodes:mapNodes(r.nodes),meshes:mapNodes(r.meshes) as Record<string,THREE.Mesh>,sockets:mapNodes(r.sockets),colliders:structuredClone(r.colliders),destructionGroups:Object.fromEntries(Object.entries(r.destructionGroups).map(([id,items])=>[id,items.map(o=>mapping.get(o)!)]))};
 root.userData.modelSource=sourceData.modelSource;root.userData.buildTiming={prototypeBuildMs,instanceCloneMs:performance.now()-before};return root;
}

