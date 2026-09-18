FROM nginx:alpine

# nginx's stock mime.types has no entry for Matroska or WAV, so files with those
# extensions are served as application/octet-stream -- which a browser downloads
# instead of playing. Each type is inserted before the closing brace of the
# types block.
RUN sed -i '$ i\    video/x-matroska mkv;' /etc/nginx/mime.types \
 && sed -i '$ i\    audio/wav wav;' /etc/nginx/mime.types \
 && nginx -t -c /etc/nginx/nginx.conf

COPY default.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html/

# Per-deployment values cannot be baked into an image that is built once and
# deployed anywhere, so the browser's js/config.js is written at container
# start instead. nginx runs everything in /docker-entrypoint.d before it begins
# serving. The COPY above landed the script in the web root along with the rest
# of the directory; move it out rather than leave it served publicly.
RUN mv /usr/share/nginx/html/docker-entrypoint.d/40-fixam-config.sh \
       /docker-entrypoint.d/40-fixam-config.sh \
 && chmod +x /docker-entrypoint.d/40-fixam-config.sh \
 && rmdir /usr/share/nginx/html/docker-entrypoint.d

# The build context is this whole directory, so the copy above also lands the
# build files in the web root: /default.conf served the nginx configuration
# itself -- internal hostnames, ports, the uploads alias -- to anyone who asked
# for it, and /Dockerfile served this file.
#
# They cannot be excluded through .dockerignore, because the COPY above needs
# default.conf present in the context. Removing them after the fact is the
# option that leaves nothing in the image to leak.
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/default.conf \
          /usr/share/nginx/html/.dockerignore \
          /usr/share/nginx/html/serve.json

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
