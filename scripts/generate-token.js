const jwt = require('jsonwebtoken');

// Get JWT_SECRET from environment or prompt
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('\n❌ Error: JWT_SECRET not found in environment variables!');
  console.log('\nSet JWT_SECRET in your .env.local file or run:');
  console.log('  JWT_SECRET=<your-secret> node scripts/generate-token.js\n');
  process.exit(1);
}

// Get project ID from command line or use default
const projectId = process.argv[2] || 'your-project-id-here';
const organizationId = process.argv[3] || 'your-org-id-here';
const type = process.argv[4] || 'api';

// Generate token
const token = jwt.sign(
  {
    projectId,
    organizationId,
    type,
  },
  JWT_SECRET,
  { expiresIn: '7d' }
);

console.log('\n✅ JWT Token Generated Successfully!\n');
console.log('─'.repeat(80));
console.log('\nToken:');
console.log(token);
console.log('\n' + '─'.repeat(80));
console.log('\nUsage:');
console.log('  curl -H "Authorization: Bearer ' + token + '" <api-url>');
console.log('\nToken Details:');
console.log('  Project ID: ' + projectId);
console.log('  Organization ID: ' + organizationId);
console.log('  Type: ' + type);
console.log('  Expires: 7 days from now');
console.log('\n' + '─'.repeat(80));
console.log('\nTo generate a token with specific IDs:');
console.log('  node scripts/generate-token.js <project-id> <org-id> <type>');
console.log('\nExample:');
console.log('  node scripts/generate-token.js 123e4567-e89b-12d3-a456-426614174000 123e4567-e89b-12d3-a456-426614174001 api\n');
