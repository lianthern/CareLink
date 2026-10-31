import * as T from './assets/three.module.js';
// Metres, north=-Z, east=+X. Relations follow 05-campus-plan.png.
// This is explicit approximate geometry, not a recovered photographic reconstruction.
const scene=new T.Scene();scene.background=new T.Color('#dce6e5');scene.fog=new T.Fog('#dce6e5',65,160);
const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});renderer.setSize(1280,720);renderer.setPixelRatio(1);renderer.outputColorSpace=T.SRGBColorSpace;
const camera=new T.PerspectiveCamera(58,1280/720,.08,250);
scene.add(new T.HemisphereLight('#fff5df','#819174',2));const sun=new T.DirectionalLight('#fff4de',2.3);sun.position.set(-30,50,20);scene.add(sun);
const materials={};function mat(color){return materials[color]??=new T.MeshStandardMaterial({color,roughness:.88});}
function box(x,y,z,w,h,d,color){const m=new T.Mesh(new T.BoxGeometry(w,h,d),mat(color));m.position.set(x,y,z);scene.add(m);return m;}
box(8,-.15,-30,110,.3,105,'#a7b397');box(0,.02,-28,17,.1,74,'#c7c5b9');box(-13,.03,-28,11,.12,57,'#cfccc1');
// School building west, auditorium north, field east; no facade closes the classroom doorway.
box(-25,6,-29,12,12,54,'#d6d2bf');box(-17.6,.05,-29,3,.2,56,'#d4d0c3');
for(let z=-4;z>=-54;z-=6){box(-16.2,1.5,z,.3,3,.3,'#e9e6dc');box(-16.2,4.6,z,.3,3,.3,'#e9e6dc');box(-16.2,7.7,z,.3,3,.3,'#e9e6dc');box(-16.2,10.8,z,.3,3,.3,'#e9e6dc');}
for(const y of [3.2,6.3,9.4,12.5])box(-17.4,y,-29,3.8,.22,57,'#e6e1d3');
for(let z=-6;z>=-52;z-=6)for(const y of [4.4,7.5,10.6])box(-18.94,y,z,.08,1.7,3.4,'#718b8b');
box(0,5,-65,20,10,14,'#d6d0bd');box(0,10.2,-65,22,.6,16,'#787e79');box(0,2,-57.9,5,4,.12,'#6e6558');box(-12,3.4,-60,12,.25,3,'#c5c1b3');
// A real accessible ground-floor classroom volume replaces the southern solid facade area.
// Placed south of main building, sharing corridor; layout is provisional pending classroom reference.
box(-25,.04,5,12,.2,12,'#cdbb98');box(-31,1.8,5,.2,3.6,12,'#e3dfd1');box(-25,1.8,11,12,3.6,.2,'#e3dfd1');box(-25,1.8,-1,12,3.6,.2,'#e3dfd1');
box(-19,1.8,8,.2,3.6,6,'#e3dfd1');box(-19,1.8,0,.2,3.6,2,'#e3dfd1');box(-19,3.3,3,.2,.6,4,'#e3dfd1');
box(-30.85,1.9,5,.08,1.3,7,'#38594b');
for(let x=-28;x<=-22;x+=2)for(let z=1;z<=9;z+=2){box(x,.77,z,1.2,.12,.65,'#bba074');for(const dx of [-.5,.5])box(x+dx,.38,z,.05,.72,.05,'#5c635d');box(x+.6,.46,z,.5,.08,.5,'#a9906c');}
// Field and track are actual surfaces, with perspective and occlusion.
box(34,.03,-30,34,.1,59,'#b77468');box(34,.1,-30,26,.1,48,'#7f9c77');
for(const x of [21,47])box(x,.17,-30,.08,.02,48,'#e0e5d4');for(const z of [-6,-30,-54])box(34,.17,z,26,.02,.08,'#e0e5d4');
function tree(x,z,r=2.5){const trunk=new T.Mesh(new T.CylinderGeometry(.2,.35,4,8),mat('#84715b'));trunk.position.set(x,2,z);scene.add(trunk);const crown=new T.Mesh(new T.IcosahedronGeometry(r,2),mat('#719365'));crown.position.set(x,5,z);scene.add(crown);}
for(let z=-8;z>=-58;z-=9){tree(15,z);tree(54,z);}for(let z=-15;z>=-48;z-=11)tree(-8,z,2);tree(0,-28,4);
// Gate is on south edge. Open passage remains visible from road and inside.
for(const x of [-8,-3,3,8])box(x,1.6,9,.7,3.2,.7,'#d9d4c5');for(let x=-8;x<=8;x+=.4)if(Math.abs(x)>3.5)box(x,1.15,9,.05,2.3,.05,'#52605a');box(0,.03,14,105,.1,8,'#a2a9a4');
const anchors=[['校门外 · 家长',0,1.5,12,'gate'],['校门内 · 老师',0,1.5,5,'gateb'],['教室后排 · 同学',-22,1.5,8,null],['课桌旁 · 同学',-28,1.4,3,null],['树下 · 毕业',-2,1.6,-28,null],['操场边 · 朋友',18,1.6,-22,null]];
const loader=new T.TextureLoader(),loads=[];
for(const [label,x,y,z,img] of anchors){const group=new T.Group();group.position.set(x,y,z);scene.add(group);const canvas=document.createElement('canvas');canvas.width=512;canvas.height=100;const c=canvas.getContext('2d');c.fillStyle='#fff8ea';c.fillRect(0,0,512,100);c.fillStyle='#334c3c';c.font='26px Microsoft YaHei';c.textAlign='center';c.fillText(label,256,60);const labelMesh=new T.Mesh(new T.PlaneGeometry(.36,.07),new T.MeshBasicMaterial({map:new T.CanvasTexture(canvas),side:T.DoubleSide}));labelMesh.position.y=-.14;group.add(labelMesh);if(img){const texture=loader.load('assets/'+img+'.png');texture.colorSpace=T.SRGBColorSpace;group.add(new T.Mesh(new T.PlaneGeometry(.36,.205),new T.MeshBasicMaterial({map:texture,side:T.DoubleSide})));}else{group.add(new T.Mesh(new T.PlaneGeometry(.36,.205),mat('#b4c2b1')));}group.rotation.y=0;}
const poses={overview:[[35,56,48],[0,0,-27]],gate:[[0,1.55,15],[0,1.55,-15]],inside:[[0,1.55,5],[-15,1.55,1]],corridor:[[-16.8,1.55,4],[-16.8,1.55,-20]],classroom:[[-20,1.55,4],[-29,1.5,4]],tree:[[-6,1.55,-25],[0,1.7,-28]]};
window.renderPose=(name,t=0)=>{const [p,target]=poses[name];camera.position.set(p[0]+t*1.5,p[1],p[2]-t*1.5);camera.lookAt(...target);camera.updateMatrixWorld();renderer.render(scene,camera);window.sceneProof={pose:name,camera:camera.position.toArray(),target,representation:'approximate explicit geometry, classroom reference pending',anchors:anchors.map(a=>({label:a[0],position:a.slice(1,4),hasGeneratedCover:!!a[4]}))};};
window.renderPose('gate');window.ready=true;

