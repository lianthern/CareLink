// Only canonical, permission-checked media routes reach the shared World renderer.
export function sharedWorldSceneOptions(context,{invitation=false}={}){
 const source=context?.world;if(!source)return null;
 const media=value=>{
  if(typeof value!=='string'||!/^\/v1\/viewer\/spaces\/[A-Za-z0-9_-]+\/world-results\/[A-Za-z0-9_-]+\/media\/(?:preview\.spz|standard\.spz|full\.spz|panorama|thumbnail|collider\.glb)(?:\?|$)/.test(value)||value.includes('..'))return null;
  const url=new URL(value,'https://local.invalid');url.searchParams.set('access',invitation?'invitation':'account');return url.pathname+url.search;
 };
 const world={id:source.id,name:source.name,marbleUrl:null,thumbnailUrl:media(source.thumbnailUrl),panoramaUrl:media(source.panoramaUrl),colliderUrl:media(source.colliderUrl),splats:{preview:media(source.splats?.preview),standard:media(source.splats?.standard),full:media(source.splats?.full)},semantics:source.semantics};
 if(!Object.values(world.splats).some(Boolean))return null;
 return {kind:'world',world,panorama:world.panoramaUrl,authenticity:'AI 根据照片补全的空间，未拍到的部分可能与现场不同。空间内移动不代表照片已完成真实三维定位。',providerExposure:context.providerExposure||source.providerExposure||'provider_may_be_public'};
}
