# Event Modeling Building Blocks

This repository contains full runnable code examples for Event Modeling slice types. Each slice type demonstrates a complete implementation from end to end, providing practical building blocks for Event Modeling practitioners.

## Structure

Each slice type is a self-contained implementation on `main`, merged from its feature branch and tagged for easy reference.

## Available Slice Types

| Slice Type | Branch/Tag | Article |
|------------|------------|---------|
| State Change | `state-change` | [One slice, end to end](https://www.linkedin.com/pulse/one-slice-end-gabriel-n-schenker-gomle/) |
| State View | `state-view` | [Read models are cheap. Coupling isn't.](https://www.linkedin.com/pulse/read-models-cheap-coupling-isnt-gabriel-n-schenker-7geqe/) |
| Automation | `automation` | [The work nobody clicks](https://www.linkedin.com/pulse/work-nobody-clicks-gabriel-n-schenker-yhzge/) (concept) + [The work nobody sees: automation slices in code](https://www.linkedin.com/pulse/work-nobody-sees-automation-slices-code-gabriel-n-schenker-nk4ve/) |
| Translation | `translation-v2` | [Their words, our facts: translation slices in code](https://www.linkedin.com/pulse/words-our-facts-translation-slices-code-gabriel-n-schenker-8ga0e/) |

Translation's latest code is tagged `translation-v2`: never-closing translation todo list → pure-mapping Translate* → …Observed → worker todo list → worker command with rules → Recorded/Rejected.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## About

These examples are designed to be educational and demonstrate best practices for implementing Event Modeling patterns in production-ready code.
