/* eslint-disable complexity */
import {
	Status,
	Payload,
	EventType,
	ListenerMap,
	SubmitReturn,
	EventListener,
	Event,
	JsApiData,
	EndpointInfo,
	ApiInfo,
	Config,
	ApiData
} from "../types";

import { post_data } from "./post_data";
import { handle_blob } from "./handle_blob";

import {
	skip_queue,
	handle_message,
	process_endpoint,
	resolve_root
} from "../helpers";
import { BROKEN_CONNECTION_MSG, QUEUE_FULL_MSG } from "../constants";
import { apply_diff_stream, close_stream, open_stream } from "./stream";
import { get_jwt } from "../helpers/data";

export function submit(
	this: any,
	endpoint: string | number,
	data: unknown[],
	event_data?: unknown,
	trigger_id?: any
): SubmitReturn {
	try {
		const { hf_token } = this.options;
		const config: Config = this.config;
		const session_hash = Math.random().toString(36).substring(2);
		const event_callbacks: Record<string, () => Promise<void>> = {};

		// API variables
		const api = this.api;
		if (!api) throw new Error("No API found");
		const api_map = this.api_map;
		let api_info: EndpointInfo<ApiData | JsApiData>;
		let { fn_index } = get_endpoint_info(api, endpoint, api_map);

		if (typeof endpoint === "number") {
			fn_index = endpoint;
			api_info = api.unnamed_endpoints[fn_index];
		} else {
			const trimmed_endpoint = endpoint.replace(/^\//, "");
			fn_index = api_map[trimmed_endpoint];
			api_info = api.named_endpoints[endpoint.trim()];
		}

		if (typeof fn_index !== "number") {
			throw new Error(
				"There is no endpoint matching that name of fn_index matching that number."
			);
		}

		let websocket: WebSocket;
		let event_stream: EventSource;
		let protocol = config.protocol ?? "ws";

		const _endpoint = typeof endpoint === "number" ? "/predict" : endpoint;
		let payload: Payload;
		let event_id: string | null = null;
		let complete: Status | undefined | false = false;
		const listener_map: ListenerMap<EventType> = {};
		let last_status: Record<string, Status["stage"]> = {};
		let url_params =
			typeof window !== "undefined"
				? new URLSearchParams(window.location.search).toString()
				: "";

		// SSE variables
		let stream_open = false;
		let pending_stream_messages: Record<string, any[]> = {}; // Event messages may be received by the SSE stream before the initial data POST request is complete. To resolve this race condition, we store the messages in a dictionary and process them when the POST request is complete.
		let pending_diff_streams: Record<string, any[][]> = {};
		const unclosed_events: Set<string> = new Set();

		let jwt: false | string = false;

		// event subscription methods
		function fire_event<K extends EventType>(event: Event<K>): void {
			const narrowed_listener_map: ListenerMap<K> = listener_map;
			const listeners = narrowed_listener_map[event.type] || [];
			listeners?.forEach((l) => l(event));
		}

		function on<K extends EventType>(
			eventType: K,
			listener: EventListener<K>
		): SubmitReturn {
			const narrowed_listener_map: ListenerMap<K> = listener_map;
			const listeners = narrowed_listener_map[eventType] || [];
			narrowed_listener_map[eventType] = listeners;
			listeners?.push(listener);

			return { on, off, cancel, destroy };
		}

		function off<K extends EventType>(
			eventType: K,
			listener: EventListener<K>
		): SubmitReturn {
			const narrowed_listener_map: ListenerMap<K> = listener_map;
			let listeners = narrowed_listener_map[eventType] || [];
			listeners = listeners?.filter((l) => l !== listener);
			narrowed_listener_map[eventType] = listeners;
			return { on, off, cancel, destroy };
		}

		async function cancel(): Promise<void> {
			const _status: Status = {
				stage: "complete",
				queue: false,
				time: new Date()
			};
			complete = _status;
			fire_event({
				..._status,
				type: "status",
				endpoint: _endpoint,
				fn_index: fn_index
			});

			let cancel_request = {};
			if (protocol === "ws") {
				if (websocket && websocket.readyState === 0) {
					websocket.addEventListener("open", () => {
						websocket.close();
					});
				} else {
					websocket.close();
				}
				cancel_request = { fn_index, session_hash };
			} else {
				event_stream.close();
				cancel_request = { event_id };
			}

			try {
				await fetch(`${config.root}/reset`, {
					headers: { "Content-Type": "application/json" },
					method: "POST",
					body: JSON.stringify(cancel_request)
				});
			} catch (e) {
				console.warn(
					"The `/reset` endpoint could not be called. Subsequent endpoint results may be unreliable."
				);
			}
		}

		function destroy(): void {
			for (const event_type in listener_map) {
				listener_map &&
					listener_map[event_type as "data" | "status"]?.forEach((fn) => {
						off(event_type as "data" | "status", fn);
					});
			}
		}

		handle_blob(`${config.root}`, data, api_info, hf_token).then(
			async (_payload) => {
				payload = {
					data: _payload || [],
					event_data,
					fn_index,
					trigger_id
				};
				if (skip_queue(fn_index, config)) {
					fire_event({
						type: "status",
						endpoint: _endpoint,
						stage: "pending",
						queue: false,
						fn_index,
						time: new Date()
					});

					post_data(
						`${config.root}/run${
							_endpoint.startsWith("/") ? _endpoint : `/${_endpoint}`
						}${url_params ? "?" + url_params : ""}`,
						{
							...payload,
							session_hash
						},
						hf_token
					)
						.then(([output, status_code]) => {
							const data = output.data;
							if (status_code == 200) {
								fire_event({
									type: "data",
									endpoint: _endpoint,
									fn_index,
									data: data,
									time: new Date()
								});

								fire_event({
									type: "status",
									endpoint: _endpoint,
									fn_index,
									stage: "complete",
									eta: output.average_duration,
									queue: false,
									time: new Date()
								});
							} else {
								fire_event({
									type: "status",
									stage: "error",
									endpoint: _endpoint,
									fn_index,
									message: output.error,
									queue: false,
									time: new Date()
								});
							}
						})
						.catch((e) => {
							fire_event({
								type: "status",
								stage: "error",
								message: e.message,
								endpoint: _endpoint,
								fn_index,
								queue: false,
								time: new Date()
							});
						});
				} else if (protocol == "ws") {
					const { ws_protocol, host, space_id } = await process_endpoint(
						this.app_reference,
						hf_token
					);

					fire_event({
						type: "status",
						stage: "pending",
						queue: true,
						endpoint: _endpoint,
						fn_index,
						time: new Date()
					});

					let url = new URL(
						`${ws_protocol}://${resolve_root(
							host,
							config.path as string,
							true
						)}/queue/join${url_params ? "?" + url_params : ""}`
					);

					if (hf_token && space_id) {
						jwt = await get_jwt(space_id, hf_token);
					}

					if (jwt) {
						url.searchParams.set("__sign", jwt);
					}

					websocket = new WebSocket(url);

					websocket.onclose = (evt) => {
						if (!evt.wasClean) {
							fire_event({
								type: "status",
								stage: "error",
								broken: true,
								message: BROKEN_CONNECTION_MSG,
								queue: true,
								endpoint: _endpoint,
								fn_index,
								time: new Date()
							});
						}
					};

					websocket.onmessage = function (event) {
						const _data = JSON.parse(event.data);
						const { type, status, data } = handle_message(
							_data,
							last_status[fn_index]
						);

						if (type === "update" && status && !complete) {
							// call 'status' listeners
							fire_event({
								type: "status",
								endpoint: _endpoint,
								fn_index,
								time: new Date(),
								...status
							});
							if (status.stage === "error") {
								websocket.close();
							}
						} else if (type === "hash") {
							websocket.send(JSON.stringify({ fn_index, session_hash }));
							return;
						} else if (type === "data") {
							websocket.send(JSON.stringify({ ...payload, session_hash }));
						} else if (type === "complete") {
							complete = status;
						} else if (type === "log") {
							fire_event({
								type: "log",
								log: data.log,
								level: data.level,
								endpoint: _endpoint,
								fn_index
							});
						} else if (type === "generating") {
							fire_event({
								type: "status",
								time: new Date(),
								...status,
								stage: status?.stage!,
								queue: true,
								endpoint: _endpoint,
								fn_index
							});
						}
						if (data) {
							fire_event({
								type: "data",
								time: new Date(),
								data: data.data,
								endpoint: _endpoint,
								fn_index
							});

							if (complete) {
								fire_event({
									type: "status",
									time: new Date(),
									...complete,
									stage: status?.stage!,
									queue: true,
									endpoint: _endpoint,
									fn_index
								});
								websocket.close();
							}
						}
					};

					// different ws contract for gradio versions older than 3.6.0
					//@ts-ignore
					if (semiver(config.version || "2.0.0", "3.6") < 0) {
						addEventListener("open", () =>
							websocket.send(JSON.stringify({ hash: session_hash }))
						);
					}
				} else if (protocol == "sse") {
					fire_event({
						type: "status",
						stage: "pending",
						queue: true,
						endpoint: _endpoint,
						fn_index,
						time: new Date()
					});
					var params = new URLSearchParams({
						fn_index: fn_index.toString(),
						session_hash: session_hash
					}).toString();
					let url = new URL(
						`${config.root}/queue/join?${
							url_params ? url_params + "&" : ""
						}${params}`
					);

					let event_stream = new EventSource(url);

					event_stream.onmessage = async function (event) {
						const _data = JSON.parse(event.data);
						const { type, status, data } = handle_message(
							_data,
							last_status[fn_index]
						);

						if (type === "update" && status && !complete) {
							// call 'status' listeners
							fire_event({
								type: "status",
								endpoint: _endpoint,
								fn_index,
								time: new Date(),
								...status
							});
							if (status.stage === "error") {
								event_stream.close();
							}
						} else if (type === "data") {
							event_id = _data.event_id as string;
							let [_, status] = await post_data(
								`${config.root}/queue/data`,
								{
									...payload,
									session_hash,
									event_id
								},
								hf_token
							);
							if (status !== 200) {
								fire_event({
									type: "status",
									stage: "error",
									message: BROKEN_CONNECTION_MSG,
									queue: true,
									endpoint: _endpoint,
									fn_index,
									time: new Date()
								});
								event_stream.close();
							}
						} else if (type === "complete") {
							complete = status;
						} else if (type === "log") {
							fire_event({
								type: "log",
								log: data.log,
								level: data.level,
								endpoint: _endpoint,
								fn_index
							});
						} else if (type === "generating") {
							fire_event({
								type: "status",
								time: new Date(),
								...status,
								stage: status?.stage!,
								queue: true,
								endpoint: _endpoint,
								fn_index
							});
						}
						if (data) {
							fire_event({
								type: "data",
								time: new Date(),
								data: data.data,
								endpoint: _endpoint,
								fn_index
							});

							if (complete) {
								fire_event({
									type: "status",
									time: new Date(),
									...complete,
									stage: status?.stage!,
									queue: true,
									endpoint: _endpoint,
									fn_index
								});
								event_stream.close();
							}
						}
					};
				} else if (
					protocol == "sse_v1" ||
					protocol == "sse_v2" ||
					protocol == "sse_v2.1" ||
					protocol == "sse_v3"
				) {
					// latest API format. v2 introduces sending diffs for intermediate outputs in generative functions, which makes payloads lighter.
					// v3 only closes the stream when the backend sends the close stream message.
					fire_event({
						type: "status",
						stage: "pending",
						queue: true,
						endpoint: _endpoint,
						fn_index,
						time: new Date()
					});

					post_data(
						`${config.root}/queue/join?${url_params}`,
						{
							...payload,
							session_hash
						},
						hf_token
					).then(([response, status]) => {
						if (status === 503) {
							fire_event({
								type: "status",
								stage: "error",
								message: QUEUE_FULL_MSG,
								queue: true,
								endpoint: _endpoint,
								fn_index,
								time: new Date()
							});
						} else if (status !== 200) {
							fire_event({
								type: "status",
								stage: "error",
								message: BROKEN_CONNECTION_MSG,
								queue: true,
								endpoint: _endpoint,
								fn_index,
								time: new Date()
							});
						} else {
							event_id = response.event_id as string;
							let callback = async function (_data: object): Promise<void> {
								try {
									const { type, status, data } = handle_message(
										_data,
										last_status[fn_index]
									);

									if (type == "heartbeat") {
										return;
									}

									if (type === "update" && status && !complete) {
										// call 'status' listeners
										fire_event({
											type: "status",
											endpoint: _endpoint,
											fn_index,
											time: new Date(),
											...status
										});
									} else if (type === "complete") {
										complete = status;
									} else if (type == "unexpected_error") {
										console.error("Unexpected error", status?.message);
										fire_event({
											type: "status",
											stage: "error",
											message:
												status?.message || "An Unexpected Error Occurred!",
											queue: true,
											endpoint: _endpoint,
											fn_index,
											time: new Date()
										});
									} else if (type === "log") {
										fire_event({
											type: "log",
											log: data.log,
											level: data.level,
											endpoint: _endpoint,
											fn_index
										});
										return;
									} else if (type === "generating") {
										fire_event({
											type: "status",
											time: new Date(),
											...status,
											stage: status?.stage!,
											queue: true,
											endpoint: _endpoint,
											fn_index
										});
										if (
											data &&
											["sse_v2", "sse_v2.1", "sse_v3"].includes(protocol)
										) {
											apply_diff_stream(pending_diff_streams, event_id!, data);
										}
									}
									if (data) {
										fire_event({
											type: "data",
											time: new Date(),
											data: data.data,
											endpoint: _endpoint,
											fn_index
										});

										if (complete) {
											fire_event({
												type: "status",
												time: new Date(),
												...complete,
												stage: status?.stage!,
												queue: true,
												endpoint: _endpoint,
												fn_index
											});
										}
									}

									if (
										status?.stage === "complete" ||
										status?.stage === "error"
									) {
										if (event_callbacks[event_id!]) {
											delete event_callbacks[event_id!];
										}
										if (event_id! in pending_diff_streams) {
											delete pending_diff_streams[event_id!];
										}
									}
								} catch (e) {
									console.error("Unexpected client exception", e);
									fire_event({
										type: "status",
										stage: "error",
										message: "An Unexpected Error Occurred!",
										queue: true,
										endpoint: _endpoint,
										fn_index,
										time: new Date()
									});
									if (["sse_v2", "sse_v2.1"].includes(protocol)) {
										close_stream(stream_open, event_stream);
									}
								}
							};

							if (event_id in pending_stream_messages) {
								pending_stream_messages[event_id].forEach((msg) =>
									callback(msg)
								);
								delete pending_stream_messages[event_id];
							}

							if (event_id) {
								// @ts-ignore
								event_callbacks[event_id] = callback;
							}
							unclosed_events.add(event_id);
							if (!stream_open) {
								open_stream(
									stream_open,
									session_hash,
									config,
									event_callbacks,
									unclosed_events,
									pending_stream_messages
								);
							}
						}
					});
				}
			}
		);

		return { on, off, cancel, destroy };
	} catch (error) {
		console.error("Submit function encountered an error:", error);
		throw error;
	}
}

function get_endpoint_info(
	api: ApiInfo<JsApiData>,
	endpoint: string | number,
	api_map: Record<string, number>
): { fn_index: number; api_info: EndpointInfo<JsApiData> } {
	const fn_index =
		typeof endpoint === "number"
			? endpoint
			: api_map[endpoint.replace(/^\//, "")];
	const api_info =
		typeof endpoint === "number"
			? api.unnamed_endpoints[fn_index]
			: api.named_endpoints[endpoint.trim()];

	if (typeof fn_index !== "number" || !api_info)
		throw new Error("Invalid endpoint");
	return { fn_index, api_info };
}
