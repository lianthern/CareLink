// Components directly ported from 回忆时刻_Demo.html. No demo state or simulated actions.
export function designDeco(cur="P0"){
  const b=[["-50px","-40px","210px","#C7DCFA"],["225px","-70px","230px","#F6CFE2"],["-80px","540px","250px","#FBDCC4"],["250px","640px","190px","#DCD1F6"]];
  let s=b.map(([l,t,w,c])=>`<span class="blob" style="left:${l};top:${t};width:${w};height:${w};background:${c}"></span>`).join("");
  const sp=[[38,120,10],[300,90,8],[70,430,7],[330,520,11],[180,700,8],[24,660,9],[250,300,7],[110,560,9]];
  s+=sp.map(([l,t,z],i)=>`<span class="spk" style="left:${l}px;top:${t}px;--s:${z}px;animation-delay:${i*.45}s"></span>`).join("");
  s+=`<span class="pband"></span>`;
  const orn=(x,y,h,d)=>`<span class="orn" style="left:${x}px;top:${y}px;animation-delay:${d}s">${h}</span>`;
  const O={
    P0:orn(316,86,`<span class="bal pink"><i></i></span>`,0)+orn(346,128,`<span class="bal gold" style="transform:scale(.72)"><i></i></span>`,1.4),
    A1:orn(-6,300,`<span class="bal silver"><i></i></span>`,.8)+orn(330,520,`<span class="bow"><i></i><i></i><b></b></span>`,1.2),
    A2:orn(304,74,`<span class="bal pink"><i></i></span>`,.4)+orn(-4,430,`<span class="bal gold" style="transform:scale(.8)"><i></i></span>`,1.6),
    B1:orn(318,92,`<span class="bow"><i></i><i></i><b></b></span>`,.6)+orn(-8,470,`<span class="bal pink" style="transform:scale(.78)"><i></i></span>`,1.8),
    B3:orn(322,96,`<span class="bal silver" style="transform:scale(.8)"><i></i></span>`,.9),
    S3:orn(-6,110,`<span class="bow"><i></i><i></i><b></b></span>`,.5)
  }[cur]||"";
  let pt="";
  for(let i=0;i<5;i++) pt+=`<span class="petal" style="left:${8+i*21}%;animation-duration:${13+i*3}s;animation-delay:${-i*4}s"></span>`;
  return `<div class="deco" aria-hidden="true">${s}${O}${pt}<span class="vig"></span></div>`;
}
