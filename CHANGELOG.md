# Changelog

All notable changes to the FIXAM project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-30

### Added
- User consent mechanism: new users must explicitly accept privacy policy before registration
- Data export endpoint (`GET /api/user/data`) for GDPR/DPG data portability compliance
- Data deletion endpoint (`DELETE /api/user/data`) for right to erasure
- Comprehensive PRIVACY.md policy document
- CI/CD pipeline with GitHub Actions (lint + test on push/PR)
- ESLint and Prettier configuration for code quality
- Automated test suite scaffold

### Changed
- Password hashing upgraded from SHA-512 to bcrypt (cost factor 12)
- CORS policy restricted to configured origins (was wildcard `*`)
- HTTPS enforcement added for production environment
- Legacy SHA-512 password verification kept as migration helper for existing users

### Security
- bcrypt replaces SHA-512 + phone salt for password storage
- Restricted CORS origins via ALLOWED_ORIGINS environment variable
- HTTPS redirect enforcement in production (x-forwarded-proto header)
- User data can now be permanently deleted on request

## [1.0.0] - 2026-03-01

### Added
- Initial release of FIXAM civic infrastructure reporting platform
- WhatsApp bot integration for issue reporting
- AI-powered intent classification for natural language interaction
- Geolocation-based issue tracking and mapping
- Community voting and endorsement system
- Gamification with points system
- Admin dashboard for issue management
- Multi-language support framework (Krio, English)
- Voice note transcription via local AI (Whisper)
