// Each view keeps its own signal and account identity, including after navigation.
export function createViewRequest(api,{signal,isCurrent}) {
  const assertCurrent=()=>{
    if(signal.aborted||!isCurrent())throw new DOMException('View is no longer current','AbortError');
  };
  return {signal,assertCurrent,request:async(path,options={})=>{
    assertCurrent();
    try {
      const result=await api.request(path,{...options,signal});
      assertCurrent();
      return result;
    } catch(error) { assertCurrent();throw error; }
  }};
}
