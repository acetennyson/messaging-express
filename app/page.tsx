export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-16">
        {/* Hero Section */}
        <div className="text-center mb-16">
          <h1 className="text-6xl font-bold text-gray-900 dark:text-white mb-4">
            Messaging Express
          </h1>
          <p className="text-2xl text-gray-600 dark:text-gray-300 mb-8">
            Messaging-as-a-Service for Modern Applications
          </p>
          <p className="text-lg text-gray-500 dark:text-gray-400 max-w-2xl mx-auto">
            Integrate real-time messaging into your apps without building from scratch.
            Support for text, images, videos, files, and more.
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-3 gap-8 mb-16">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-4xl mb-4">💬</div>
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
              Real-Time Messaging
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              WebSocket-powered instant messaging with typing indicators and presence.
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-4xl mb-4">📸</div>
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
              Rich Media Support
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Send images, videos, files, and more with automatic thumbnail generation.
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-4xl mb-4">🏢</div>
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
              Multi-Tenant
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Organizations, projects, and users with complete isolation and security.
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-4xl mb-4">🔐</div>
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
              Secure by Default
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              JWT authentication, rate limiting, and per-project API keys.
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-4xl mb-4">🪝</div>
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
              Webhooks
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Real-time event notifications with automatic retry and delivery tracking.
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
            <div className="text-4xl mb-4">📊</div>
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
              Analytics
            </h3>
            <p className="text-gray-600 dark:text-gray-400">
              Track usage, monitor performance, and understand your users.
            </p>
          </div>
        </div>

        {/* API Example */}
        <div className="bg-white dark:bg-gray-800 rounded-lg p-8 shadow-lg mb-16">
          <h2 className="text-3xl font-bold mb-6 text-gray-900 dark:text-white">
            Quick Start
          </h2>
          
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2 text-gray-900 dark:text-white">
                1. Send a Message
              </h3>
              <pre className="bg-gray-900 text-green-400 p-4 rounded-lg overflow-x-auto text-sm">
{`POST /api/v1/messages
Authorization: Bearer <your-jwt-token>

{
  "conversationId": "uuid",
  "senderId": "uuid",
  "content": "Hello, world!",
  "type": "text"
}`}
              </pre>
            </div>

            <div>
              <h3 className="text-lg font-semibold mb-2 text-gray-900 dark:text-white">
                2. Create a Conversation
              </h3>
              <pre className="bg-gray-900 text-green-400 p-4 rounded-lg overflow-x-auto text-sm">
{`POST /api/v1/conversations
Authorization: Bearer <your-jwt-token>

{
  "type": "group",
  "title": "Project Discussion",
  "participantIds": ["user-1", "user-2"]
}`}
              </pre>
            </div>

            <div>
              <h3 className="text-lg font-semibold mb-2 text-gray-900 dark:text-white">
                3. Upload Media
              </h3>
              <pre className="bg-gray-900 text-green-400 p-4 rounded-lg overflow-x-auto text-sm">
{`POST /api/v1/messages
Authorization: Bearer <your-jwt-token>

{
  "conversationId": "uuid",
  "senderId": "uuid",
  "content": "Check this out!",
  "attachments": [{
    "type": "image",
    "url": "https://cdn.example.com/image.jpg"
  }]
}`}
              </pre>
            </div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="text-center">
          <h2 className="text-3xl font-bold mb-6 text-gray-900 dark:text-white">
            Ready to Get Started?
          </h2>
          <div className="flex justify-center gap-4">
            <a
              href="https://github.com/your-repo"
              className="px-8 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
            >
              View on GitHub
            </a>
            <a
              href="/api/health"
              className="px-8 py-3 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg font-semibold hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Check API Status
            </a>
          </div>
          
          <div className="mt-12 text-gray-500 dark:text-gray-400">
            <p className="mb-2">Read the full documentation:</p>
            <div className="space-x-4">
              <a href="/README.md" className="underline hover:text-blue-600">
                README
              </a>
              <a href="/DATABASE_SCHEMA.md" className="underline hover:text-blue-600">
                Database Schema
              </a>
              <a href="/ARCHITECTURE.md" className="underline hover:text-blue-600">
                Architecture
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
