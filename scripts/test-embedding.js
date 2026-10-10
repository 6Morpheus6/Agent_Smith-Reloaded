const { pipeline } = require('@xenova/transformers');

(async () => {
  console.log('Loading all-MiniLM-L6-v2...');
  const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.log('Model loaded. Testing embedding...');
  const output = await pipe('hello world test', { pooling: 'mean', normalize: true });
  const vec = Array.from(output.data);
  console.log('Vector length:', vec.length);
  console.log('First 5 values:', vec.slice(0, 5).map(v => v.toFixed(4)).join(', '));
  // Verify it's normalized (unit vector)
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  console.log('Norm:', Math.sqrt(norm).toFixed(6), '(should be ~1.0)');
})();
