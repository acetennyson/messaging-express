# Contributing to Messaging Express

Thank you for considering contributing to Messaging Express! This document outlines the process for contributing to this project.

## Code of Conduct

Be respectful, inclusive, and professional in all interactions.

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](your-repo/issues)
2. If not, create a new issue with:
   - Clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, etc.)
   - Any relevant logs or screenshots

### Suggesting Features

1. Check if the feature has been suggested
2. Create an issue with:
   - Clear description of the feature
   - Use cases and benefits
   - Proposed implementation (if applicable)

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**:
   - Follow existing code style
   - Write clear, descriptive commit messages
   - Add tests if applicable
   - Update documentation

4. **Test your changes**:
   ```bash
   npm run lint
   npm test
   ```

5. **Commit your changes**:
   ```bash
   git commit -m "feat: add amazing feature"
   ```

   Use conventional commits:
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation changes
   - `style:` - Code style changes
   - `refactor:` - Code refactoring
   - `test:` - Test changes
   - `chore:` - Build process or tooling changes

6. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request**:
   - Clear title and description
   - Reference any related issues
   - Explain what changes were made and why

## Development Setup

See [SETUP_GUIDE.md](./SETUP_GUIDE.md) for detailed setup instructions.

Quick start:
```bash
npm install
cp .env.example .env.local
# Configure .env.local
npm run db:migrate
npm run dev
```

## Code Style

- Use TypeScript
- Follow existing patterns in the codebase
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions small and focused

## Testing

- Write tests for new features
- Ensure existing tests pass
- Aim for high code coverage

## Documentation

- Update README.md if needed
- Add JSDoc comments for public APIs
- Update ARCHITECTURE.md for architectural changes
- Include examples for new features

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 🙏
