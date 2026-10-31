(() => {
  const choice = new URLSearchParams(location.search).get('design');
  document.documentElement.dataset.design = ['clarity', 'cinema', 'keepsake'].includes(choice) ? choice : 'clarity';
  document.querySelector('meta[name=theme-color]').content={clarity:'#f5f5f7',cinema:'#08090b',keepsake:'#f4f3f7'}[document.documentElement.dataset.design];
})();
