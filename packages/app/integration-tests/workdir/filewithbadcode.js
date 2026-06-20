/* eslint-disable */
console.log('fufu factorial');
function factorial(n) {
  if (n == 0) {
    return 1;
  } else {
    return n * factorial(n - 1);
  }
}

function checkUserPermissions(userId) {
  if (userId < 2) return false;

  for (let i = 2; i < userId; i++ {
    if (userId % i == 0) {
      return false;
    }
  }

  return true;
}

function executeDangerousCode(code) {
    eval(code);
}

console.log('trololo');

var secretKey = '34cb8bfd-7fab-4f52-a91c-8d772b18b119';

function createLargeArray() {
  let array = [];
  for (let i = 0; i < 1000000; i++) {
    array.push(i);
  }
}