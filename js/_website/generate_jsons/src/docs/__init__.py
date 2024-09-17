import html
import json
import os
import re
import requests


from gradio_client.documentation import document_cls, generate_documentation
import gradio
from ..guides import guides

DIR = os.path.dirname(__file__)
DEMOS_DIR = os.path.abspath(os.path.join(DIR, "../../../../../demo"))
JS_CLIENT_README = os.path.abspath(os.path.join(DIR, "../../../../../client/js/README.md"))
JS_DIR = os.path.abspath(os.path.join(DIR, "../../../../../js/"))
TEMPLATES_DIR = os.path.abspath(os.path.join(DIR, "../../../src/lib/templates"))

docs = generate_documentation()

def add_component_shortcuts():
    for component in docs["component"]:
        if not getattr(component["class"], "allow_string_shortcut", True):
            continue
        component["string_shortcuts"] = [
            (
                component["class"].__name__,
                component["name"].lower(),
                "Uses default values",
            )
        ]
        for subcls in component["class"].__subclasses__():
            if getattr(subcls, "is_template", False):
                _, tags, _ = document_cls(subcls)
                component["string_shortcuts"].append(
                    (
                        subcls.__name__,
                        subcls.__name__.lower(),
                        "Uses " + tags.get("sets", "default values"),
                    )
                )


add_component_shortcuts()


def add_demos():
    for mode in docs:
        for cls in docs[mode]:
            if "demos" not in cls["tags"]:
                continue
            cls["demos"] = []
            demos = [demo.strip() for demo in cls["tags"]["demos"].split(",")]
            for demo in demos:
                demo_file = os.path.join(DEMOS_DIR, demo, "run.py")
                with open(demo_file) as run_py:
                    demo_code = run_py.read()
                    demo_code = demo_code.replace("# type: ignore", "")
                cls["demos"].append((demo, demo_code))


add_demos()

def create_events_matrix():
    events = set({})
    component_events = {}
    for component in docs["component"]:
        component_event_list = []
        if hasattr(component["class"], 'EVENTS'):
            for event in component["class"].EVENTS:
                events.add(event)
                for fn in component["fns"]:
                    if event == fn["name"]:
                        component_event_list.append(event)
            component_events[component["name"]] = component_event_list
    
    
    return list(events), component_events

events, component_events = create_events_matrix()


def add_guides():
    for mode in docs:
        for cls in docs[mode]:
            if "guides" not in cls["tags"]:
                continue
            cls["guides"] = []
            docstring_guides = [
                guide.strip() for guide in cls["tags"]["guides"].split(",")
            ]
            for docstring_guide in docstring_guides:
                for guide in guides:
                    if docstring_guide == guide["name"]:
                        cls["guides"].append(guide)


add_guides()


def escape_parameters(parameters):
    new_parameters = []
    for param in parameters:
        param = param.copy()  # Manipulating the list item directly causes issues, so copy it first
        param["doc"] = html.escape(param["doc"]) if param["doc"] else param["doc"]
        new_parameters.append(param)
    assert len(new_parameters) == len(parameters)
    return new_parameters


def escape_html_string_fields():
    for mode in docs:
        for cls in docs[mode]:
            for tag in [
                "preprocessing",
                "postprocessing",
                "examples-format",
                "events",
            ]:
                if tag not in cls["tags"]:
                    continue
                cls["tags"][tag] = html.escape(cls["tags"][tag])

            cls["parameters"] = escape_parameters(cls["parameters"])
            for fn in cls["fns"]:
                fn["description"] = html.escape(fn["description"])
                fn["parameters"] = escape_parameters(fn["parameters"])

escape_html_string_fields()

def find_cls(target_cls):
    for mode in docs:
        for cls in docs[mode]:
            if cls["name"] == target_cls:
                return cls
    raise ValueError("Class not found")


def organize_docs(d):
    organized = {
        "gradio": {
            "building": {},
            "components": {},
            "helpers": {},
            "modals": {},
            "routes": {},
            "events": {},
            "chatinterface": {}
        },
        "python-client": {}
    }
    for mode in d:
        for c in d[mode]:
            c["parent"] = "gradio"
            c["class"] = None
            if "returns" in c:
                c["returns"]["annotation"] = None
            for p in c.get("parameters", []):
                p["annotation"] = str(p["annotation"])
                if "default" in p:
                    p["default"] = str(p["default"])
            for f in c["fns"]:
                f["fn"] = None
                f["parent"] = "gradio." + c["name"]
                for p in f.get("parameters", []):
                    p["annotation"] = str(p["annotation"])
                    if "default" in p:
                        p["default"] = str(p["default"])
            if mode == "component":
                organized["gradio"]["components"][c["name"].lower()] = c
            elif mode == "py-client":
                organized["python-client"][c["name"].lower()] = c
            elif mode in ["helpers", "routes", "chatinterface", "modals"]:
                organized["gradio"][mode][c["name"].lower()] = c                
            else:
                organized["gradio"]["building"][c["name"].lower()] = c
    

    def format_name(page_name):
        index = None
        page_path = page_name
        if re.match("^[0-9]+_", page_name):
            index = int(page_name[: page_name.index("_")])
            page_name = page_name[page_name.index("_") + 1 :]
        if page_name.lower().endswith(".svx"):
            page_name = page_name[:-4]
        pretty_page_name = " ".join([word[0].upper() + word[1:] for word in page_name.split("-")])
        for library in organized:
            for category in organized[library]:
                if page_name in organized[library][category]:
                    return index, page_name, organized[library][category][page_name]["name"], page_path
        if page_name == "chatinterface": 
            pretty_page_name =  "ChatInterface"              
        return index, page_name, pretty_page_name, page_path
    
    
    def organize_pages(): 
        pages = {"gradio": [], "python-client": [], "third-party-clients": []}
        absolute_index = -1;
        for library in pages:
            library_templates_dir = os.path.join(TEMPLATES_DIR, library)
            page_folders = sorted(os.listdir(library_templates_dir))
            for page_folder in page_folders:
                page_list = sorted(os.listdir(os.path.join(library_templates_dir, page_folder)))
                _, page_category, pretty_page_category, category_path = format_name(page_folder)
                category_path = os.path.join(library, category_path)
                pages[library].append({"category": pretty_page_category, "pages": []})
                for page_file in page_list:
                    page_index, page_name, pretty_page_name, page_path = format_name(page_file)
                    pages[library][-1]["pages"].append({"name": page_name, "pretty_name": pretty_page_name, "path": os.path.join(category_path, page_path), "page_index": page_index, "abolute_index": absolute_index + 1})
        return pages

    pages = organize_pages()

    organized["gradio"]["events_matrix"] = component_events
    organized["gradio"]["events"] = events

    js = {}
    js_pages = []

    for js_component in os.listdir(JS_DIR):
        if not js_component.startswith("_") and js_component not in ["app", "highlighted-text", "playground", "preview", "upload-button", "theme", "tootils"]:
            if os.path.exists(os.path.join(JS_DIR, js_component, "package.json")):
                with open(os.path.join(JS_DIR, js_component, "package.json")) as f:
                    package_json = json.load(f)
                    if package_json.get("private", False):
                        continue
            if os.path.exists(os.path.join(JS_DIR, js_component, "README.md")):
                with open(os.path.join(JS_DIR, js_component, "README.md")) as f:
                    readme_content = f.read()

                try: 
                    latest_npm = requests.get(f"https://registry.npmjs.org/@gradio/{js_component}/latest").json()["version"]
                    latest_npm = f" [v{latest_npm}](https://www.npmjs.com/package/@gradio/{js_component})"
                    readme_content = readme_content.split("\n")
                    readme_content = "\n".join([readme_content[0], latest_npm, *readme_content[1:]])
                except TypeError:
                    pass

                js[js_component] = readme_content
                js_pages.append(js_component)


    with open(JS_CLIENT_README) as f:
        readme_content = f.read()
    js_pages.append("js-client")

    js["js-client"] = readme_content

    js_pages.sort()

    return {"docs": organized, "pages": pages, "js": js, "js_pages": js_pages, "js_client": readme_content}


docs = organize_docs(docs)

gradio_docs = docs["docs"]["gradio"]

SYSTEM_PROMPT = """
Generate code for using the Gradio python library. 

The following RULES must be followed.  Whenever you are forming a response, ensure all rules have been followed otherwise start over.

RULES: 
Only respond with code, not text.
Only respond with valid Python syntax.
Never include backticks in your response such as ``` or ```python. 
Never use any external library aside from: gradio, numpy, pandas, plotly, transformers_js and matplotlib.
Do not include any code that is not necessary for the app to run.
Respond with a full Gradio app. 
Only respond with one full Gradio app.
Add comments explaining the code, but do not include any text that is not formatted as a Python comment.



Here's an example of a valid response:

# This is a simple Gradio app that greets the user.
import gradio as gr

# Define a function that takes a name and returns a greeting.
def greet(name):
    return "Hello " + name + "!"

# Create a Gradio interface that takes a textbox input, runs it through the greet function, and returns output to a textbox.`
demo = gr.Interface(fn=greet, inputs="textbox", outputs="textbox")

# Launch the interface.
demo.launch()


Here are some more examples of Gradio apps:


"""



# important_demos = ["annotatedimage_component", "audio_component_events", "audio_mixer", "bar_plot_demo", "blocks_chained_events", "blocks_essay", "blocks_essay_simple", "blocks_flashcards", "blocks_flipper", "blocks_form", "blocks_hello", "blocks_js_load", "blocks_js_methods", "blocks_kinematics", "blocks_layout", "blocks_outputs", "blocks_plug", "blocks_simple_squares", "blocks_update", "blocks_xray", "calculator", "chatbot_consecutive", "chatbot_multimodal", "chatbot_simple", "chatbot_streaming", "chatinterface_multimodal", "custom_css", "datetimes", "diff_texts", "dropdown_key_up", "fake_diffusion", "fake_gan", "filter_records", "function_values", "gallery_component_events", "generate_tone", "hangman", "hello_blocks", "hello_blocks_decorator", "hello_world", "image_editor", "matrix_transpose", "model3D", "on_listener_decorator", "plot_component", "render_merge", "render_split", "reverse_audio_2", "sales_projections", "scatter_plot_demo", "sentence_builder", "sepia_filter", "sort_records", "streaming_simple", "tabbed_interface_lite", "tax_calculator", "theme_soft", "timer", "timer_simple", "variable_outputs", "video_identity"]
important_demos = ["annotatedimage_component", "audio_component_events", "audio_mixer", "blocks_chained_events", "blocks_essay", "blocks_essay_simple", "blocks_flipper", "blocks_form", "blocks_hello", "blocks_js_load", "blocks_js_methods", "blocks_kinematics", "blocks_layout", "blocks_plug", "blocks_simple_squares", "blocks_update", "blocks_xray", "calculator", "chatbot_consecutive", "chatbot_multimodal", "chatbot_simple", "chatbot_streaming", "chatinterface_multimodal", "custom_css", "datetimes", "diff_texts", "dropdown_key_up", "fake_diffusion", "fake_gan", "filter_records", "function_values", "gallery_component_events", "generate_tone", "hangman", "hello_blocks", "hello_blocks_decorator", "hello_world", "image_editor", "matrix_transpose", "model3D", "on_listener_decorator", "plot_component", "render_merge", "render_split", "reverse_audio_2", "sales_projections", "sentence_builder", "sepia_filter", "sort_records", "streaming_simple", "tabbed_interface_lite", "tax_calculator", "theme_soft", "timer", "timer_simple", "variable_outputs", "video_identity"]

important_demos_8k = ["blocks_essay_simple", "blocks_flipper", "blocks_form", "blocks_hello", "blocks_kinematics", "blocks_layout", "blocks_simple_squares", "calculator", "chatbot_consecutive", "chatbot_simple", "chatbot_streaming", "chatinterface_multimodal", "datetimes", "diff_texts", "dropdown_key_up", "fake_diffusion", "filter_records", "generate_tone", "hangman", "hello_blocks", "hello_blocks_decorator", "hello_world", "image_editor", "matrix_transpose", "model3D", "on_listener_decorator", "plot_component", "render_merge", "render_split", "reverse_audio_2", "sepia_filter", "sort_records", "streaming_simple", "tabbed_interface_lite", "tax_calculator", "theme_soft", "timer", "timer_simple", "variable_outputs", "video_identity"]


def length(demo):
    if os.path.exists(os.path.join(DEMOS_DIR, demo, "run.py")):
        demo_file = os.path.join(DEMOS_DIR, demo, "run.py")
    else: 
        return 0
    with open(demo_file) as run_py:
        demo_code = run_py.read()
        demo_code = demo_code.replace("# type: ignore", "").replace('if __name__ == "__main__":\n    ', "")
    return len(demo_code)

# important_demos_8k.sort(key=lambda x: length(x))
# print(important_demos_8k)
# print(len(important_demos_8k))

SYSTEM_PROMPT += "\n\nHere are some demos showcasing full Gradio apps: \n\n"

SYSTEM_PROMPT_8K = SYSTEM_PROMPT

for demo in important_demos:
    if os.path.exists(os.path.join(DEMOS_DIR, demo, "run.py")):
        demo_file = os.path.join(DEMOS_DIR, demo, "run.py")
    else: 
        continue
    with open(demo_file) as run_py:
        demo_code = run_py.read()
        demo_code = demo_code.replace("# type: ignore", "").replace('if __name__ == "__main__":\n    ', "")
    SYSTEM_PROMPT += f"Name: {demo.replace('_', ' ')}\n"
    SYSTEM_PROMPT += "Code: \n\n"
    SYSTEM_PROMPT += f"{demo_code}\n\n"

for demo in important_demos_8k:
    if os.path.exists(os.path.join(DEMOS_DIR, demo, "run.py")):
        demo_file = os.path.join(DEMOS_DIR, demo, "run.py")
    else: 
        continue
    with open(demo_file) as run_py:
        demo_code = run_py.read()
        demo_code = demo_code.replace("# type: ignore", "").replace('if __name__ == "__main__":\n    ', "")
    SYSTEM_PROMPT_8K += f"Name: {demo.replace('_', ' ')}\n"
    SYSTEM_PROMPT_8K += "Code: \n\n"
    SYSTEM_PROMPT_8K += f"{demo_code}\n\n"


SYSTEM_PROMPT += """

The following RULES must be followed.  Whenever you are forming a response, after each sentence ensure all rules have been followed otherwise start over, forming a new response and repeat until the finished response follows all the rules.  then send the response.

RULES: 
Only respond with code, not text.
Only respond with valid Python syntax.
Never include backticks in your response such as ``` or ```python. 
Never use any external library aside from: gradio, numpy, pandas, plotly, transformers_js and matplotlib.
Do not include any code that is not necessary for the app to run.
Respond with a full Gradio app. 
Only respond with one full Gradio app.
Add comments explaining the code, but do not include any text that is not formatted as a Python comment.
"""

SYSTEM_PROMPT_8K += """

The following RULES must be followed.  Whenever you are forming a response, after each sentence ensure all rules have been followed otherwise start over, forming a new response and repeat until the finished response follows all the rules.  then send the response.

RULES: 
Only respond with code, not text.
Only respond with valid Python syntax.
Never include backticks in your response such as ``` or ```python. 
Never use any external library aside from: gradio, numpy, pandas, plotly, transformers_js and matplotlib.
Do not include any code that is not necessary for the app to run.
Respond with a full Gradio app. 
Only respond with one full Gradio app.
Add comments explaining the code, but do not include any text that is not formatted as a Python comment.
"""


def generate(json_path):
    with open(json_path, "w+") as f:
        json.dump(docs, f)
    return  SYSTEM_PROMPT, SYSTEM_PROMPT_8K