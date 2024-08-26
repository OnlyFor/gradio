import gradio as gr
from gradio import ChatMessage
import time

def generate_response(history):
    history.append(ChatMessage(role="user", content="What is the weather in San Francisco right now?"))
    yield history
    time.sleep(0.25)
    history.append(ChatMessage(role="assistant",
                               content="In order to find the current weather in San Francisco, I will need to use my weather tool.")
                               )
    yield history
    time.sleep(0.25)

    history.append(ChatMessage(role="assistant",
                               content="API Error when connecting to weather service.",
                              metadata={"title": "💥 Error using tool 'Weather'"})
                  )
    yield history
    time.sleep(5)

    history.append(ChatMessage(role="assistant",
                               content="I will try again",
                              ))
    yield history
    time.sleep(0.25)

    history.append(ChatMessage(role="assistant",
                               content="Weather 72 degrees Fahrenheit with 20% chance of rain.",
                                metadata={"title": "🛠️ Used tool 'Weather'"}
                              ))
    yield history
    time.sleep(0.25)

    history.append(ChatMessage(role="assistant",
                               content="Now that the API succeeded I can complete my task.",
                              ))
    yield history
    time.sleep(0.25)

    history.append(ChatMessage(role="assistant",
                               content="It's a sunny day in San Francisco with a current temperature of 72 degrees Fahrenheit and a 20% chance of rain. Enjoy the weather!",
                              ))
    yield history


with gr.Blocks() as demo:
    chatbot  = gr.Chatbot(type="messages",
                          value=[{"role": "user", "content": "What is the weather in San Francisco?"},
                                 {"role": "assistant", "content": "I need to use the weather API tool",
                                  "metadata": {"title":  "🧠 Thinking"}}])


if __name__ == "__main__":
    demo.launch()