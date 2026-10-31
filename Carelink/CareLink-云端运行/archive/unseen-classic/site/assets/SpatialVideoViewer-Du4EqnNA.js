import{r as e}from"./rolldown-runtime-S-ySWqyJ.js";import{a as t}from"./framework-BMoSGwBH.js";import{n,r}from"./jsx-runtime-BFA9jBFM.js";var i=e(t(),1),a=`
  attribute vec2 a_position;
  varying vec2 v_position;
  void main() {
    v_position = a_position;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`,o=`
  precision highp float;
  varying vec2 v_position;
  uniform sampler2D u_texture;
  uniform float u_yaw;
  uniform float u_pitch;
  uniform float u_fov;
  uniform float u_aspect;
  const float PI = 3.141592653589793;

  void main() {
    float tangent = tan(u_fov * 0.5);
    vec3 direction = normalize(vec3(
      v_position.x * u_aspect * tangent,
      v_position.y * tangent,
      1.0
    ));

    float cp = cos(u_pitch);
    float sp = sin(u_pitch);
    direction = vec3(
      direction.x,
      direction.y * cp + direction.z * sp,
      -direction.y * sp + direction.z * cp
    );

    float cy = cos(u_yaw);
    float sy = sin(u_yaw);
    direction = vec3(
      direction.x * cy + direction.z * sy,
      direction.y,
      -direction.x * sy + direction.z * cy
    );

    float longitude = atan(direction.x, direction.z);
    float latitude = asin(clamp(direction.y, -1.0, 1.0));
    vec2 uv = vec2(
      fract(longitude / (2.0 * PI) + 0.5),
      0.5 - latitude / PI
    );
    gl_FragColor = texture2D(u_texture, uv);
  }
`,s=e=>e*Math.PI/180,c=(e,t,n)=>Math.min(n,Math.max(t,e));function l(e,t,n){let r=e.createShader(t);if(!r)throw Error(`无法创建空间视频着色器`);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS))throw Error(e.getShaderInfoLog(r)||`空间视频着色器编译失败`);return r}function u(e){let t=e.getContext(`webgl`,{antialias:!0,alpha:!1,powerPreference:`high-performance`});if(!t)throw Error(`当前浏览器不支持 360° 空间视频`);let n=t.createProgram();if(!n)throw Error(`无法创建空间视频程序`);let r=l(t,t.VERTEX_SHADER,a),i=l(t,t.FRAGMENT_SHADER,o);if(t.attachShader(n,r),t.attachShader(n,i),t.linkProgram(n),!t.getProgramParameter(n,t.LINK_STATUS))throw Error(t.getProgramInfoLog(n)||`空间视频程序链接失败`);t.useProgram(n);let s=t.createBuffer();if(!s)throw Error(`无法创建空间视频缓冲区`);t.bindBuffer(t.ARRAY_BUFFER,s),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),t.STATIC_DRAW);let c=t.getAttribLocation(n,`a_position`);t.enableVertexAttribArray(c),t.vertexAttribPointer(c,2,t.FLOAT,!1,0,0);let u=t.createTexture();if(!u)throw Error(`无法创建空间视频纹理`);return t.bindTexture(t.TEXTURE_2D,u),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),{gl:t,program:n,vertexShader:r,fragmentShader:i,buffer:s,texture:u,yaw:t.getUniformLocation(n,`u_yaw`),pitch:t.getUniformLocation(n,`u_pitch`),fov:t.getUniformLocation(n,`u_fov`),aspect:t.getUniformLocation(n,`u_aspect`)}}var d=(0,i.forwardRef)(function({videoUrl:e,posterUrl:t,playing:a,guided:o,initialView:l,onPlaybackChange:d,onTimeChange:f,onViewChange:p,onReady:m},h){let g=(0,i.useRef)(null),_=(0,i.useRef)(null),v=(0,i.useRef)(null),y=(0,i.useRef)(null),b=(0,i.useRef)(null),x=(0,i.useRef)(0),S=(0,i.useRef)(0),C=(0,i.useRef)(o),w=(0,i.useRef)(!1),T=(0,i.useRef)(!1),E=(0,i.useRef)({yawDeg:l?.yawDeg??-8,pitchDeg:l?.pitchDeg??-1,fovDeg:l?.fovDeg??67}),D=(0,i.useRef)(null),O=(0,i.useRef)(d),k=(0,i.useRef)(f),A=(0,i.useRef)(p),[j,M]=(0,i.useState)(!1),[N,P]=(0,i.useState)(null),[F,I]=(0,i.useState)(!1),[L,R]=(0,i.useState)(null);(0,i.useEffect)(()=>{if(e.startsWith(`blob:`)||e.startsWith(`data:`)){P(e);return}let t=new AbortController,n=null,r=!0;return fetch(e,{cache:`force-cache`,signal:t.signal}).then(e=>{if(!e.ok)throw Error(`空间视频下载失败：${e.status}`);return e.blob()}).then(e=>{r&&(n=URL.createObjectURL(e),P(n))}).catch(t=>{!r||t instanceof DOMException&&t.name===`AbortError`||P(e)}),()=>{r=!1,t.abort(),n&&URL.revokeObjectURL(n)}},[e]),(0,i.useEffect)(()=>{O.current=d},[d]),(0,i.useEffect)(()=>{k.current=f},[f]),(0,i.useEffect)(()=>{A.current=p},[p]),(0,i.useImperativeHandle)(h,()=>({seek(e,t){let n=v.current;n&&(n.currentTime=c(e,0,Number.isFinite(n.duration)?Math.max(0,n.duration-.04):e),t&&(E.current.yawDeg=t.yawDeg,E.current.pitchDeg=t.pitchDeg,typeof t.fovDeg==`number`&&(E.current.fovDeg=c(t.fovDeg,44,88))),S.current=performance.now()+2600,k.current(n.currentTime,Number.isFinite(n.duration)?n.duration:0))}}),[]),(0,i.useEffect)(()=>{C.current=o},[o]),(0,i.useEffect)(()=>{let e=_.current;if(!e)return;let t;try{t=u(e),y.current=t}catch(e){requestAnimationFrame(()=>{R(e instanceof Error?e.message:`空间视频初始化失败`)});return}let n=e=>{let t=g.current,r=_.current,i=v.current,a=y.current;if(!t||!r||!i||!a)return;let o=Math.min(window.devicePixelRatio||1,2),c=Math.max(1,Math.round(t.clientWidth*o)),l=Math.max(1,Math.round(t.clientHeight*o));if((r.width!==c||r.height!==l)&&(r.width=c,r.height=l),i.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA&&C.current&&e>S.current){let e=i.currentTime;E.current={yawDeg:-12+e*2.75+Math.sin(e*.48)*3.2,pitchDeg:-1.2+Math.sin(e*2.25)*.55,fovDeg:66-Math.sin(e*.31)*2.4}}let{gl:u,program:d}=a;if(i.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA)try{u.bindTexture(u.TEXTURE_2D,a.texture),u.pixelStorei(u.UNPACK_FLIP_Y_WEBGL,0),u.texImage2D(u.TEXTURE_2D,0,u.RGBA,u.RGBA,u.UNSIGNED_BYTE,i),w.current||(w.current=!0,M(!0))}catch{T.current||(T.current=!0,R(`空间视频帧读取失败`))}let f=E.current;u.viewport(0,0,c,l),u.useProgram(d),u.uniform1f(a.yaw,s(f.yawDeg)),u.uniform1f(a.pitch,s(f.pitchDeg)),u.uniform1f(a.fov,s(f.fovDeg)),u.uniform1f(a.aspect,c/l),u.drawArrays(u.TRIANGLES,0,6),e-x.current>90&&(x.current=e,k.current(i.currentTime,Number.isFinite(i.duration)?i.duration:0),A.current?.({...f})),b.current=requestAnimationFrame(n)};return b.current=requestAnimationFrame(n),()=>{b.current!==null&&cancelAnimationFrame(b.current);let{gl:e}=t;e.deleteTexture(t.texture),e.deleteBuffer(t.buffer),e.deleteProgram(t.program),e.deleteShader(t.vertexShader),e.deleteShader(t.fragmentShader),y.current=null}},[]),(0,i.useEffect)(()=>{let e=v.current;!e||!N||(a?e.play().catch(()=>{O.current(!1)}):e.pause())},[N,a]);let z=e=>{e.currentTarget.setPointerCapture(e.pointerId),D.current={pointerId:e.pointerId,x:e.clientX,y:e.clientY,yawDeg:E.current.yawDeg,pitchDeg:E.current.pitchDeg},S.current=performance.now()+6e3,I(!0)},B=e=>{let t=D.current;!t||t.pointerId!==e.pointerId||(E.current.yawDeg=t.yawDeg+(t.x-e.clientX)*.16,E.current.pitchDeg=c(t.pitchDeg+(e.clientY-t.y)*.13,-58,58))},V=e=>{D.current?.pointerId===e.pointerId&&(D.current=null,I(!1))};return r(`div`,{ref:g,className:`motion-video-shell${F?` is-dragging`:``}`,style:t?{"--motion-poster":`url("${t}")`}:void 0,role:`application`,"aria-label":`可拖动环看的 360 度空间视频。空格播放或暂停，方向键改变视角。`,tabIndex:0,onPointerDown:z,onPointerMove:B,onPointerUp:V,onPointerCancel:V,onWheel:e=>{e.preventDefault(),E.current.fovDeg=c(E.current.fovDeg+e.deltaY*.035,44,88),S.current=performance.now()+4500},onKeyDown:e=>{if(e.key===` `){e.preventDefault(),O.current(!a);return}(e.key===`ArrowLeft`||e.key===`ArrowRight`)&&(e.preventDefault(),E.current.yawDeg+=e.key===`ArrowLeft`?-7:7,S.current=performance.now()+5e3),(e.key===`ArrowUp`||e.key===`ArrowDown`)&&(e.preventDefault(),E.current.pitchDeg=c(E.current.pitchDeg+(e.key===`ArrowUp`?5:-5),-58,58),S.current=performance.now()+5e3)},children:[n(`video`,{ref:v,className:`motion-video-source`,crossOrigin:`anonymous`,src:N??void 0,poster:t||void 0,preload:`auto`,muted:!0,loop:!0,playsInline:!0,"aria-hidden":`true`,onLoadedData:()=>{w.current=!0,M(!0),m?.();let e=v.current;e&&a&&e.play().catch(()=>{O.current(!1)})},onPlay:()=>O.current(!0),onPause:()=>O.current(!1),onError:()=>R(`空间视频加载失败`)}),n(`canvas`,{ref:_,"aria-hidden":`true`}),!j&&!L?r(`div`,{className:`motion-video-loading`,role:`status`,children:[n(`span`,{}),`正在载入空间视频`]}):null,L?r(`div`,{className:`motion-video-fallback`,children:[n(`p`,{children:L}),n(`video`,{crossOrigin:`anonymous`,src:N??e,poster:t||void 0,controls:!0,muted:!0,playsInline:!0})]}):null,r(`div`,{className:`motion-viewer-hint`,"aria-hidden":`true`,children:[n(`span`,{children:`↔`}),`拖动画面环看`]})]})});export{d as t};