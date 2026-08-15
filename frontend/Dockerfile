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

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
