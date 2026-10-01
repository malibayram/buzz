FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p buzz-voice-agent

FROM debian:bookworm-slim
COPY --from=build /src/target/release/buzz-voice-agent /usr/local/bin/buzz-voice-agent
ENTRYPOINT ["buzz-voice-agent"]
