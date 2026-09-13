/**
 * Babel config for Jest (and Metro, when it needs one).
 * Metro has its own internal default from expo, but Jest only sees
 * babel-jest + this file, so this is what makes `import` statements in
 * src/*.js and @noble/* compile to CommonJS for the test runner.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};