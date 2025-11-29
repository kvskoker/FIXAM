#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Starting Proxy Setup...${NC}"

# 1. Load Environment Variables
if [ ! -f backend/.env ]; then
    echo -e "${RED}Error: backend/.env file not found!${NC}"
    exit 1
fi

echo "Loading configuration..."
export $(grep -v '^#' backend/.env | xargs)

if [ -z "$APP_URL" ]; then
    echo -e "${YELLOW}Warning: APP_URL is not set in backend/.env${NC}"
    echo "Please add APP_URL=https://yourdomain.com or APP_URL=http://localhost:3000 to backend/.env"
    exit 1
fi

echo "APP_URL is set to: $APP_URL"

# Extract Domain and Protocol
PROTOCOL=$(echo $APP_URL | grep :// | sed -e's,^\(.*://\).*,\1,g')
URL_NO_PROTO=$(echo $APP_URL | sed -e s,$PROTOCOL,,g)
DOMAIN=$(echo $URL_NO_PROTO | cut -d/ -f1 | cut -d: -f1)

echo "Detected Domain: $DOMAIN"

# 2. Check if Localhost
if [ "$DOMAIN" = "localhost" ] || [ "$DOMAIN" = "127.0.0.1" ]; then
    echo -e "${GREEN}APP_URL is localhost. Skipping Nginx/SSL setup.${NC}"
    echo "You can access the application at $APP_URL"
    exit 0
fi

# 3. Install Nginx and Certbot
echo -e "${GREEN}Installing Nginx and Certbot...${NC}"
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx

# 4. Configure Nginx
echo -e "${GREEN}Configuring Nginx for $DOMAIN...${NC}"

CONFIG_FILE="/etc/nginx/sites-available/$DOMAIN"

# Create Nginx Config
sudo bash -c "cat > $CONFIG_FILE" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Frontend Proxy
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Backend API Proxy
    location /api {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

# Enable Site
if [ ! -f "/etc/nginx/sites-enabled/$DOMAIN" ]; then
    sudo ln -s $CONFIG_FILE /etc/nginx/sites-enabled/
fi

# Remove default if it exists
if [ -f "/etc/nginx/sites-enabled/default" ]; then
    sudo rm /etc/nginx/sites-enabled/default
fi

# Test and Reload Nginx
echo "Testing Nginx configuration..."
sudo nginx -t
sudo systemctl reload nginx

# 5. Setup SSL with Let's Encrypt
echo -e "${GREEN}Setting up SSL with Let's Encrypt...${NC}"
echo "Running Certbot..."

# We use --nginx plugin. 
# --non-interactive requires --agree-tos and --email. 
# Since we don't have the user's email, we'll run it interactively if possible, 
# or ask the user to run it manually if this script is automated.
# However, for a helper script, we can try to run it.

if sudo certbot --nginx -d $DOMAIN --register-unsafely-without-email --agree-tos --redirect; then
    echo -e "${GREEN}SSL Certificate installed successfully!${NC}"
else
    echo -e "${RED}Certbot failed. You may need to run it manually:${NC}"
    echo "sudo certbot --nginx -d $DOMAIN"
fi

echo -e "${GREEN}Proxy setup complete!${NC}"
echo "Your application should now be accessible at https://$DOMAIN"
