import type {
	ApiInfo,
	ClientOptions,
	Config,
	JsApiData,
	SpaceStatus,
	Status,
	SubmitReturn,
	UploadResponse,
	client_return
} from "./types";
import { view_api } from "./utils/view_api";
import { upload_files } from "./utils/upload_files";
import { handle_blob } from "./utils/handle_blob";
import { post_data } from "./utils/post_data";
import { predict } from "./utils/predict";
import { submit } from "./utils/submit";
import {
	RE_SPACE_NAME,
	map_names_to_ids,
	process_endpoint,
	resolve_config
} from "./helpers";
import { check_space_status } from "./helpers/spaces";

export class NodeBlob extends Blob {
	constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) {
		super(blobParts, options);
	}
}

export class Client {
	app_reference: string;
	options: ClientOptions;

	config!: Config;
	api!: ApiInfo<JsApiData>;
	api_map: Record<string, number> = {};
	session_hash: string = Math.random().toString(36).substring(2);
	jwt: string | false = false;
	last_status: Record<string, Status["stage"]> = {};

	// streaming
	stream_status = { open: false };
	pending_stream_messages: Record<string, any[][]> = {};
	pending_diff_streams: Record<string, any[][]> = {};
	event_stream: EventSource | null = null;
	event_callbacks: Record<string, () => Promise<void>> = {};
	unclosed_events: Set<string> = new Set();

	fetch_implementation(
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> {
		return fetch(input, init);
	}

	eventSource_factory(url: URL): any {
		if (typeof window !== undefined && typeof EventSource !== "undefined") {
			return new EventSource(url.toString());
		}
		return () => {}; // todo: polyfill eventsource for node envs
	}

	view_api: (
		fetch_implementation?: typeof fetch
	) => Promise<ApiInfo<JsApiData>>;
	upload_files: (
		root: string,
		files: (Blob | File)[],
		fetch_implementation: typeof fetch,
		token?: `hf_${string}`,
		upload_id?: string
	) => Promise<UploadResponse>;
	handle_blob: (
		endpoint: string,
		data: unknown[],
		api_info: any,
		fetch_implementation: typeof fetch,
		token?: `hf_${string}`
	) => Promise<unknown[]>;
	post_data: (
		endpoint: string,
		data: unknown[],
		api_info: any,
		token?: `hf_${string}`
	) => Promise<unknown[]>;
	submit: (
		endpoint: string | number,
		data: unknown[],
		event_data?: unknown,
		trigger_id?: number | null
	) => SubmitReturn;
	predict: (
		endpoint: string | number,
		data?: unknown[],
		event_data?: unknown
	) => Promise<unknown>;

	constructor(app_reference: string, options: ClientOptions = {}) {
		this.app_reference = app_reference;
		this.options = options;

		this.view_api = view_api.bind(this);
		this.upload_files = upload_files.bind(this);
		this.handle_blob = handle_blob.bind(this);
		this.post_data = post_data.bind(this);
		this.submit = submit.bind(this);
		this.predict = predict.bind(this);
	}

	private async init(): Promise<void> {
		if (
			(typeof window === "undefined" || !("WebSocket" in window)) &&
			!global.WebSocket
		) {
			const ws = await import("ws");
			// @ts-ignore
			NodeBlob = (await import("node:buffer")).Blob;
			global.WebSocket = ws.WebSocket as unknown as typeof WebSocket;
		}

		this.config = await this._resolve_config();

		// connect to the heartbeat endpoint via GET request
		const heartbeat_url = new URL(
			`${this.config.root}/heartbeat/${this.session_hash}`
		);

		this.eventSource_factory(heartbeat_url); // Just connect to the endpoint without parsing the response. Ref: https://github.com/gradio-app/gradio/pull/7974#discussion_r1557717540

		this.api = await this.view_api(this.fetch_implementation);
		this.api_map = map_names_to_ids(this.config?.dependencies || []);
	}

	static async create(
		app_reference: string,
		options: ClientOptions = {}
	): Promise<Client> {
		const client = new Client(app_reference, options);
		await client.init();
		return client;
	}

	private async _resolve_config(): Promise<any> {
		const { http_protocol, host, space_id } = await process_endpoint(
			this.app_reference,
			this.options.hf_token
		);

		const { hf_token, status_callback } = this.options;
		let config: Config | undefined;

		try {
			config = await resolve_config(
				this.fetch_implementation,
				`${http_protocol}//${host}`,
				hf_token
			);

			if (!config) {
				throw new Error("No config or app_id set");
			}

			return this.config_success(config);
		} catch (e) {
			console.error(e);
			if (space_id) {
				check_space_status(
					space_id,
					RE_SPACE_NAME.test(space_id) ? "space_name" : "subdomain",
					this.handle_space_success
				);
			} else {
				if (status_callback)
					status_callback({
						status: "error",
						message: "Could not load this space.",
						load_status: "error",
						detail: "NOT_FOUND"
					});
			}
		}
	}

	// todo: check return object
	private async config_success(
		_config: Config
	): Promise<Config | client_return> {
		this.config = _config;

		if (typeof window !== "undefined") {
			if (window.location.protocol === "https:") {
				this.config.root = this.config.root.replace("http://", "https://");
			}
		}

		this.api_map = map_names_to_ids(_config.dependencies || []);
		if (this.config.auth_required) {
			return this.prepare_return_obj();
		}

		try {
			this.api = await this.view_api(this.fetch_implementation);
		} catch (e) {
			console.error(`Could not get API details: ${(e as Error).message}`);
		}

		return {
			...this.config,
			...this.prepare_return_obj()
		};
	}

	async handle_space_success(status: SpaceStatus): Promise<Config | void> {
		const { status_callback } = this.options;
		if (status_callback) status_callback(status);
		if (status.status === "running") {
			try {
				this.config = await this._resolve_config();
				const _config = await this.config_success(this.config);

				return _config as Config;
			} catch (e) {
				console.error(e);
				if (status_callback) {
					status_callback({
						status: "error",
						message: "Could not load this space.",
						load_status: "error",
						detail: "NOT_FOUND"
					});
				}
			}
		}
	}

	public async component_server(
		component_id: number,
		fn_name: string,
		data: unknown[]
	): Promise<unknown> {
		const headers: {
			Authorization?: string;
			"Content-Type": "application/json";
		} = { "Content-Type": "application/json" };

		if (this.options.hf_token) {
			headers.Authorization = `Bearer ${this.options.hf_token}`;
		}
		let root_url: string;
		let component = this.config.components.find(
			(comp) => comp.id === component_id
		);
		if (component?.props?.root_url) {
			root_url = component.props.root_url;
		} else {
			root_url = this.config.root;
		}
		const response = await this.fetch_implementation(
			`${root_url}/component_server/`,
			{
				method: "POST",
				body: JSON.stringify({
					data: data,
					component_id: component_id,
					fn_name: fn_name,
					session_hash: this.session_hash
				}),
				headers
			}
		);

		if (!response.ok) {
			throw new Error(
				"Could not connect to component server: " + response.statusText
			);
		}

		const output = await response.json();
		return output;
	}

	private prepare_return_obj(): client_return {
		return {
			predict: this.predict,
			submit: this.submit,
			view_api: this.view_api,
			component_server: this.component_server
		};
	}
}

export type ClientInstance = Client;
