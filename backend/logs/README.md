# Fixam Backend Logs

This directory contains log files for debugging the WhatsApp bot functionality.

## Log Files

All log files are named with the pattern: `{category}_{YYYY-MM-DD}.log`

### Available Log Categories

1. **webhook_{date}.log**
   - Contains all incoming webhook data from WhatsApp
   - Shows message types, sender info, and full message objects
   - Useful for debugging message reception issues

2. **media_download_{date}.log**
   - Detailed logs of media download process from Facebook Graph API
   - Shows:
     - Media ID being processed
     - Access token status (first 20 chars only for security)
     - Step 1: Getting media URL from Graph API
     - Step 2: Downloading binary from media URL
     - Success/failure status with error details
   - Useful for debugging attachment download issues

3. **media_handler_{date}.log**
   - Logs from the media message handler
   - Shows user state, media processing, and file saving
   - Useful for debugging the full media handling flow

## How to Use

1. Send a message via WhatsApp
2. Check the corresponding log file in this directory
3. Look for error messages or unexpected behavior
4. Logs include timestamps for easy correlation

## Example Log Entry

```
[2025-11-30T00:05:48.123Z] ========== Starting media download for ID: 825144160320755 ==========
[2025-11-30T00:05:48.124Z] PHONE_NUMBER_ID: 123456789
[2025-11-30T00:05:48.125Z] ACCESS_TOKEN: EAABsbCS1iHoBOZC...
[2025-11-30T00:05:48.126Z] STEP 1: Getting media URL from Graph API
[2025-11-30T00:05:48.127Z] Request URL: https://graph.facebook.com/v17.0/825144160320755
[2025-11-30T00:05:48.500Z] Response Status: 200
[2025-11-30T00:05:48.501Z] Response Data:
{
  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/...",
  "mime_type": "image/jpeg",
  "sha256": "...",
  "file_size": 84895,
  "id": "825144160320755",
  "messaging_product": "whatsapp"
}
[2025-11-30T00:05:48.502Z] Media URL: https://lookaside.fbsbx.com/...
[2025-11-30T00:05:48.503Z] Mime Type: image/jpeg
[2025-11-30T00:05:48.504Z] STEP 2: Downloading binary from media URL
[2025-11-30T00:05:49.200Z] Download Status: 200
[2025-11-30T00:05:49.201Z] Downloaded Size: 84895 bytes
[2025-11-30T00:05:49.202Z] ========== Download complete for ID: 825144160320755 ==========
```

## Troubleshooting

If you see errors in the logs:

- **401 Unauthorized**: Check your ACCESS_TOKEN in .env file
- **404 Not Found**: Media ID might be expired or invalid
- **Timeout**: Network issues or slow connection
- **Permission denied**: Check Facebook app permissions

## Security Note

Access tokens are partially masked in logs (only first 20 characters shown) for security.
