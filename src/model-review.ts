import * as THREE from 'three';
import {createMedicalHeart} from './models/MedicalHeart';
const scene=new THREE.Scene();scene.background=new THREE.Color('#ffffff');const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;document.body.append(renderer.domElement);
const camera=new THREE.OrthographicCamera(-1.00,1.00,1.35,-1.35,.01,30);const root=createMedicalHeart();scene.add(root);scene.add(new THREE.HemisphereLight('#fff7ed','#9ea8c0',1.7));const key=new THREE.DirectionalLight('#fff4e5',3);key.position.set(-3,4,5);scene.add(key);const fill=new THREE.DirectionalLight('#dce8ff',1.4);fill.position.set(4,1,3);scene.add(fill);const rim=new THREE.DirectionalLight('#ffffff',2);rim.position.set(2,3,-4);scene.add(rim);
const look=new URLSearchParams(location.search).get('look')||'reference-match';
if(look==='neutral'){key.color.set('#ffffff');key.intensity=2;fill.color.set('#ffffff');fill.intensity=1.6;rim.intensity=1;}
if(look==='grazing'){key.position.set(-5,.3,1);key.intensity=3.4;fill.intensity=.35;rim.intensity=.8;scene.children.forEach(o=>{if(o instanceof THREE.HemisphereLight)o.intensity=.7;});}
const view=Number(new URLSearchParams(location.search).get('angle')||0)*Math.PI/180;camera.position.set(Math.sin(view)*6,.20,Math.cos(view)*6);camera.lookAt(0,.20,0);camera.updateProjectionMatrix();
(window as any).__sculpt={scene,root,renderer,camera};(window as any).__ready=false;
renderer.render(scene,camera);(window as any).__ready=true;
