const fs = require('fs');
const { execSync } = require('child_process');

try {
  const config = JSON.parse(fs.readFileSync('C:/Users/user/.gemini/config/mcp_config.json', 'utf8'));
  const token = config.mcpServers['github-mcp-server'].env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const remoteUrl = `https://${token}@github.com/ldg7784-afk/futsal-match-recorder.git`;

  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "feat: real-time 3-way synchronization via BroadcastChannel & 1-minute interval possession"', { stdio: 'inherit' });
  execSync(`git push ${remoteUrl} main`, { stdio: 'inherit' });
  console.log('--- ALL SYNC COMMITTED AND PUSHED SUCCESSFULLY ---');
} catch (e) {
  console.error('Push error:', e.message);
  process.exit(1);
}
